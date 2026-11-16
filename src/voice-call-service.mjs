import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "./instance-identity.mjs";
import {
  execFileCrossPlatform,
  providerCandidatePaths,
  resolveExecutableCrossPlatform,
} from "./platform.mjs";
import { cleanPreviewText } from "./thread-display.mjs";
import {
  agyExecutable,
  AntigravityAcpClient,
  createAcpPermissionResponse,
  DEFAULT_AGY_MODEL,
  FALLBACK_AGY_MODELS,
  listAgyModelsFromCli,
  normalizeAcpPermissionRequest,
} from "./providers/antigravity-acp-client.mjs";
import { discoverAntigravityProfiles } from "./providers/profile-discovery.mjs";

export const VOICE_CALL_TAG = "[AC_VOICE_CALL]";
export const DEFAULT_VOICE_TTS_NAME = "zh-CN-XiaoxiaoNeural";
export const DEFAULT_VOICE_HYDROGEN_MODEL = "gemini-4-hydrogen-low";
const MAX_ACTIVE_CALL_SESSIONS = 6;
const MAX_CALL_STATES = 12;
const MAX_UTTERANCES_PER_CALL = 24;
const UNHEARD_TTL_MS = 180_000;
const STALE_PENDING_MS = 15_000;
const MODEL_CACHE_TTL_MS = 120_000;
const EDGE_TTS_TIMEOUT_MS = 3_500;
const VOICE_PROMPT_TIMEOUT_MS = 60_000;

const TRAD_TO_SIMP_MAP = Object.freeze({
  進: "进", 麼: "么", 現: "现", 開: "开", 個: "个", 務: "务", 對: "对", 話: "话",
  會: "会", 線: "线", 確: "确", 認: "认", 審: "审", 讓: "让", 幫: "帮", 總: "总",
  結: "结", 匯: "汇", 報: "报", 暫: "暂", 繼: "继", 續: "续", 運: "运", 測: "测",
  試: "试", 檢: "检", 剛: "刚", 說: "说", 聽: "听", 聲: "声", 關: "关", 閉: "闭",
  換: "换", 項: "项", 態: "态", 處: "处", 發: "发", 給: "给", 過: "过", 來: "来",
  沒: "没", 還: "还", 這: "这", 裡: "里", 邊: "边", 絲: "丝", 顯: "显", 樣: "样",
  題: "题", 錯: "错", 誤: "误", 敗: "败", 斷: "断", 連: "连", 構: "构", 單: "单",
  詳: "详", 細: "细", 況: "况", 嗎: "吗", 點: "点", 選: "选", 擇: "择", 複: "复",
  盤: "盘", 評: "评", 優: "优", 庫: "库", 碼: "码", 號: "号", 數: "数", 據: "据",
  圖: "图", 視: "视", 頻: "频", 麥: "麦", 靜: "静", 語: "语", 臺: "台", 設: "设",
  計: "计", 劃: "划", 問: "问", 無: "无", 與: "与", 為: "为", 並: "并", 從: "从",
  當: "当", 該: "该", 經: "经", 動: "动", 讀: "读", 寫: "写", 刪: "删", 製: "制",
  備: "备", 檔: "档", 錄: "录", 啟: "启", 執: "执", 狀: "状", 實: "实", 時: "时",
  統: "统", 裝: "装", 顧: "顾", 兩: "两", 誰: "谁", 請: "请", 議: "议", 論: "论",
  傳: "传", 達: "达", 調: "调", 轉: "转", 載: "载", 網: "网", 絡: "络", 頁: "页",
  麵: "面", 鐘: "钟", 條: "条", 環: "环", 長: "长", 區: "区", 塊: "块", 變: "变",
  記: "记", 歷: "历", 詢: "询", 應: "应", 別: "别",
});

export function normalizeSpokenChineseText(input = "") {
  const raw = String(input || "");
  if (!raw) return "";
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    out += TRAD_TO_SIMP_MAP[ch] || ch;
  }
  return out;
}

export function resolveEdgeTtsExecutable(env = process.env, {
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  return resolveExecutableCrossPlatform({
    envVar: "EDGE_TTS_BIN",
    candidates: providerCandidatePaths("edge-tts", { env, homeDir, platform }),
    binaryName: "edge-tts",
    env,
    platform,
    strictExplicit: true,
  }) || "";
}

export function resolveMacSayExecutable(env = process.env, {
  platform = process.platform,
} = {}) {
  const explicit = String(env?.MACOS_SAY_BIN ?? "").trim();
  if (explicit) {
    if (/^(?:none|0|false)$/i.test(explicit)) return "";
    return resolveExecutableCrossPlatform({
      envVar: "MACOS_SAY_BIN",
      strictExplicit: true,
      env,
      platform,
    }) || "";
  }
  if (platform !== "darwin") return "";
  return resolveExecutableCrossPlatform({
    candidates: ["/usr/bin/say"],
    binaryName: "say",
    env,
    platform,
  }) || "";
}

export function stripSpeechNoise(input = "", maxChars = 360) {
  let text = String(input || "")
    .replace(/<!--\s*GOAL_COMPLETE\s*-->/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "，代码部分已略，")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~>|]/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b(?:antigravity|codex|claude|grok):[a-z0-9_-]+:[a-z0-9_-]+\b/gi, "")
    .replace(/(?:\/[\w.@+-]+){2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).trim()}…`;
  }
  return text;
}

export function estimateSpeechDurationMs(text = "") {
  const clean = stripSpeechNoise(text, 360);
  if (!clean) return 0;
  const hanCount = (clean.match(/\p{Script=Han}/gu) || []).length;
  const wordCount = (clean.match(/[A-Za-z0-9_]+/g) || []).length;
  const punctCount = (clean.match(/[，。！？；：,.!?;:]/g) || []).length;
  const rawMs = 240 + hanCount * 205 + wordCount * 290 + punctCount * 160;
  return Math.max(600, Math.min(45_000, Math.round(rawMs)));
}

export function minAudibleDurationMs(text = "") {
  const clean = stripSpeechNoise(text, 360);
  if (!clean) return 0;
  return Math.max(180, Math.min(1100, Math.round(estimateSpeechDurationMs(clean) * 0.22)));
}

export function isRepeatVoiceIntent(text = "") {
  const clean = normalizeSpokenChineseText(text).trim();
  if (!clean) return false;
  if (/(修复|修改|排查|代码|测试|单元测试|新开|新建|创建|切到|打开|文件|日志)/.test(clean)) {
    return false;
  }
  return /(没听到|没听见|没听清|听不见|听不清|没声音|没有声音|刚才说什么|刚刚说什么|上一句说什么|再说一遍|再说一次|再播一遍|再讲一遍|重播|重复一下|重复一遍|大声点|\brepeat(?:\s+that|\s+last)?\b)/i.test(clean);
}

export function pickPreferredHydrogenModel(models = [], preferredOverride = "") {
  const override = String(preferredOverride || "").trim();
  if (override) return override;
  const list = (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === "string"
      ? { id: m.trim(), text: m.trim().toLowerCase(), effort: "" }
      : {
          id: String(m?.id || m?.model || "").trim(),
          text: `${m?.id || ""} ${m?.model || ""} ${m?.baseModel || ""} ${m?.displayName || ""}`.toLowerCase(),
          effort: String(m?.defaultReasoningEffort || "").toLowerCase(),
        }))
    .filter((m) => Boolean(m.id));
  const isSlowFamily = (m) => /(orchestrator|carbon|opus)/i.test(m.text);
  const matchers = [
    (m) => m.id === DEFAULT_VOICE_HYDROGEN_MODEL,
    (m) => m.text.includes("hydrogen") && (m.effort === "low" || /\b(low|fast|lite)\b|-low\b/.test(m.text)),
    (m) => m.text.includes("hydrogen") && !/\b(medium|high|xhigh)\b|-(medium|high|xhigh)\b/.test(m.text),
    (m) => m.text.includes("hydrogen") && (m.effort === "medium" || /\bmedium\b|-medium\b/.test(m.text)),
    (m) => m.id === "gemini-3.8-flash-low",
    (m) => /\b(flash|argon)\b/.test(m.text) && (m.effort === "low" || /\b(low|fast|lite)\b|-low\b/.test(m.text)),
    (m) => m.text.includes("hydrogen") && !/\bxhigh\b|-xhigh\b/.test(m.text),
    (m) => m.text.includes("hydrogen"),
    (m) => /\bflash\b/.test(m.text),
    (m) => !isSlowFamily(m) && (m.effort === "low" || /-(low|fast|lite)\b/.test(m.text)),
  ];
  for (const matcher of matchers) {
    const hit = list.find(matcher);
    if (hit?.id) return hit.id;
  }
  return DEFAULT_VOICE_HYDROGEN_MODEL;
}

export const VOICE_LIGHT_PROVIDER_PRIORITY = Object.freeze(["antigravity", "claude", "codex", "grok"]);

function voiceModelScoreForProvider(provider, item) {
  const id = String(item?.id || item?.model || "").trim().toLowerCase();
  const text = `${id} ${item?.displayName || ""} ${item?.description || ""}`.toLowerCase();
  const effort = String(item?.defaultReasoningEffort || "").toLowerCase();
  if (provider === "antigravity") {
    if (id === DEFAULT_VOICE_HYDROGEN_MODEL) return 1000;
    if (text.includes("hydrogen") && (effort === "low" || /\b(low|fast|lite)\b|-low\b/.test(text))) return 900;
    if (text.includes("hydrogen")) return 820;
    if (/\bflash\b|\bargon\b/.test(text)) return 760;
    if (/(orchestrator|carbon|opus)/.test(text)) return 200;
    return 500;
  }
  if (provider === "claude") {
    if (id === "claude-haiku-5-5") return 960;
    if (id === "claude-haiku-4-5") return 940;
    if (text.includes("haiku")) return 920;
    if (/\b(fast|mini|flash|lite)\b/.test(text)) return 800;
    if (text.includes("sonnet")) return 600;
    if (text.includes("opus")) return 250;
    return 450;
  }
  if (provider === "codex") {
    if (/\bmini\b/.test(text) && !text.includes("preview")) return 950;
    if (/\b(mini|spark|nano|fast|lite)\b/.test(text)) return 900;
    if (effort === "low") return 760;
    if (item?.isDefault) return 680;
    if (/\bmax\b|\bxhigh\b|\bpro\b/.test(text)) return 300;
    return 500;
  }
  if (provider === "grok") {
    if (/\b(mini|fast|lite|small)\b/.test(text)) return 900;
    if (item?.isDefault) return 700;
    return 500;
  }
  return item?.isDefault ? 600 : 400;
}

export function pickPreferredVoiceModel(provider, models = [], preferredOverride = "") {
  const override = String(preferredOverride || "").trim();
  if (override) return override;
  const prov = String(provider || "").trim().toLowerCase();
  if (prov === "local") return "local-rules";
  if (prov === "antigravity") return pickPreferredHydrogenModel(models, "");
  const list = (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === "string"
      ? { id: m.trim(), displayName: m.trim(), description: "", defaultReasoningEffort: "", isDefault: false }
      : {
          id: String(m?.id || m?.model || "").trim(),
          displayName: String(m?.displayName || m?.model || m?.id || "").trim(),
          description: String(m?.description || ""),
          defaultReasoningEffort: String(m?.defaultReasoningEffort || ""),
          isDefault: Boolean(m?.isDefault),
        }))
    .filter((m) => Boolean(m.id));
  if (list.length > 0) {
    const ranked = [...list].sort((a, b) => voiceModelScoreForProvider(prov, b) - voiceModelScoreForProvider(prov, a));
    return ranked[0].id;
  }
  if (prov === "claude") return "claude-haiku-4-5";
  if (prov === "codex") return "gpt-5.4-mini";
  if (prov === "grok") return "grok-3-mini";
  return "";
}

function voiceProviderDisplayName(provider) {
  switch (String(provider || "").toLowerCase()) {
    case "antigravity":
      return "Antigravity";
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "grok":
      return "Grok";
    case "local":
      return "本机规则";
    default:
      return String(provider || "AI");
  }
}

function formatVoiceModelShortName(provider, model) {
  const prov = String(provider || "").toLowerCase();
  const raw = String(model || "").trim();
  if (prov === "local" || raw === "local-rules") return "本地规则";
  if (!raw) return voiceProviderDisplayName(prov);
  if (/hydrogen/i.test(raw)) return "Hydrogen";
  if (/haiku/i.test(raw)) return raw.replace(/^claude-/i, "").replace(/-(\d)/g, " $1");
  return raw.replace(/^gemini-\d+(?:\.\d+)?-/i, "");
}

function buildLocalSubagentSummary({ instruction = "", snapshot = {}, threadSnippet = "" } = {}) {
  const cleanAsk = stripSpeechNoise(instruction, 48);
  const parts = [];
  if (threadSnippet) {
    parts.push(`当前聚焦会话最新结论是：${stripSpeechNoise(threadSnippet, 140)}。`);
  }
  const briefing = summarizeFallbackBriefing(snapshot, { askResult: true });
  if (briefing) parts.push(briefing);
  if (!parts.length) {
    parts.push(cleanAsk
      ? `关于「${cleanAsk}」，当前处于本机轻量规则模式，暂时未连接外部推理模型。你可以在顶部切换 Claude、Codex 或 Antigravity 轻量模型来获取深度分析。`
      : "当前处于本机规则模式，所有语音播报与快捷调度均正常运行。");
  }
  return parts.join(" ");
}

function extensionForAudioMime(mimeType = "") {
  const low = String(mimeType || "").toLowerCase();
  if (low.includes("mpeg") || low.includes("mp3")) return "mp3";
  if (low.includes("mp4") || low.includes("m4a") || low.includes("aac")) return "m4a";
  if (low.includes("ogg")) return "ogg";
  if (low.includes("webm")) return "webm";
  return "wav";
}

export function analyzeWavPcm16Activity(
  audioInput,
  {
    minDurationMs = 140,
    minPeak = 0.008,
    minRms = 0.0028,
    minMaxFrameRms = 0.008,
    frameMs = 20,
    allowLegacyZeroMockStub = false,
  } = {},
) {
  let buf;
  if (Buffer.isBuffer(audioInput)) {
    buf = audioInput;
  } else if (audioInput instanceof Uint8Array) {
    buf = Buffer.from(audioInput.buffer, audioInput.byteOffset, audioInput.byteLength);
  } else {
    const clean = String(audioInput || "").replace(/^data:[^;]+;base64,/, "").trim();
    if (!clean) {
      return {
        inspected: true,
        hasSpeech: false,
        reason: "empty_audio",
        durationMs: 0,
        sampleCount: 0,
        sampleRate: 0,
        channels: 0,
        rms: 0,
        peak: 0,
        maxFrameRms: 0,
      };
    }
    buf = Buffer.from(clean, "base64");
  }

  if (buf.length < 44) {
    const isWavHeader = buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
    if (isWavHeader || buf.length < 64) {
      return {
        inspected: true,
        hasSpeech: false,
        reason: "too_short_audio",
        durationMs: 0,
        sampleCount: 0,
        sampleRate: 0,
        channels: 0,
        rms: 0,
        peak: 0,
        maxFrameRms: 0,
      };
    }
    return { inspected: false, hasSpeech: true, reason: "non_wav_container" };
  }

  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return { inspected: false, hasSpeech: true, reason: "non_wav_container" };
  }

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataEnd = -1;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const paddedSize = chunkSize + (chunkSize % 2);
    if (chunkId === "fmt " && bodyStart + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(bodyStart);
      channels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      bitsPerSample = buf.readUInt16LE(bodyStart + 14);
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      dataEnd = Math.min(buf.length, bodyStart + chunkSize);
      break;
    }
    if (paddedSize <= 0 && chunkSize === 0) {
      offset = bodyStart;
    } else {
      offset = bodyStart + paddedSize;
    }
  }

  if (dataStart < 0 || dataEnd <= dataStart) {
    return {
      inspected: true,
      hasSpeech: false,
      reason: "empty_audio",
      durationMs: 0,
      sampleCount: 0,
      sampleRate,
      channels,
      rms: 0,
      peak: 0,
      maxFrameRms: 0,
    };
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || sampleRate <= 0 || channels <= 0) {
    return { inspected: false, hasSpeech: true, reason: "non_pcm16_wav" };
  }

  const totalSamples = Math.floor((dataEnd - dataStart) / 2);
  const frameCount = Math.floor(totalSamples / channels);
  if (frameCount <= 0) {
    return {
      inspected: true,
      hasSpeech: false,
      reason: "empty_audio",
      durationMs: 0,
      sampleCount: 0,
      sampleRate,
      channels,
      rms: 0,
      peak: 0,
      maxFrameRms: 0,
    };
  }

  const durationMs = Math.round((frameCount / sampleRate) * 1000);
  const samplesPerWindow = Math.max(1, Math.round((sampleRate * channels * frameMs) / 1000));
  let peak = 0;
  let sumSq = 0;
  let winSumSq = 0;
  let winCount = 0;
  let maxFrameRms = 0;

  for (let i = 0; i < totalSamples; i += 1) {
    const sample = buf.readInt16LE(dataStart + i * 2) / 32768;
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    const sq = sample * sample;
    sumSq += sq;
    winSumSq += sq;
    winCount += 1;
    if (winCount >= samplesPerWindow) {
      const frameRms = Math.sqrt(winSumSq / winCount);
      if (frameRms > maxFrameRms) maxFrameRms = frameRms;
      winSumSq = 0;
      winCount = 0;
    }
  }
  if (winCount > 0) {
    const frameRms = Math.sqrt(winSumSq / winCount);
    if (frameRms > maxFrameRms) maxFrameRms = frameRms;
  }
  const rms = Math.sqrt(sumSq / totalSamples);

  if (allowLegacyZeroMockStub && peak === 0 && frameCount === 1600 && sampleRate === 16000 && channels === 1) {
    return {
      inspected: true,
      hasSpeech: true,
      isLegacyMockStub: true,
      reason: "legacy_mock_stub",
      durationMs,
      sampleCount: frameCount,
      sampleRate,
      channels,
      rms: 0,
      peak: 0,
      maxFrameRms: 0,
    };
  }

  if (durationMs < minDurationMs) {
    return {
      inspected: true,
      hasSpeech: false,
      reason: "too_short_audio",
      durationMs,
      sampleCount: frameCount,
      sampleRate,
      channels,
      rms,
      peak,
      maxFrameRms,
    };
  }
  if (peak < minPeak) {
    return {
      inspected: true,
      hasSpeech: false,
      reason: "digital_silence",
      durationMs,
      sampleCount: frameCount,
      sampleRate,
      channels,
      rms,
      peak,
      maxFrameRms,
    };
  }
  if (rms < minRms || maxFrameRms < minMaxFrameRms) {
    return {
      inspected: true,
      hasSpeech: false,
      reason: "ambient_noise_only",
      durationMs,
      sampleCount: frameCount,
      sampleRate,
      channels,
      rms,
      peak,
      maxFrameRms,
    };
  }

  return {
    inspected: true,
    hasSpeech: true,
    reason: "speech_detected",
    durationMs,
    sampleCount: frameCount,
    sampleRate,
    channels,
    rms,
    peak,
    maxFrameRms,
  };
}

function parseCoordinatorJson(rawText = "", fallbackTranscript = "") {
  const raw = String(rawText || "").trim();
  const candidates = [];
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (unfenced) candidates.push(unfenced);
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rawDispatchMode = String(parsed.dispatchMode || "").trim().toLowerCase();
        const rawTier = String(parsed.executionTier || "").trim();
        const intentVal = String(parsed.intent || "summarize_progress").trim();
        const inferredTier = ["self_simple", "subagent_hydrogen", "external_thread"].includes(rawTier)
          ? rawTier
          : intentVal === "subagent_hydrogen"
            ? "subagent_hydrogen"
            : ["send_turn", "create_thread", "interrupt_thread"].includes(intentVal)
              ? "external_thread"
              : "self_simple";
        return {
          heardText: String(parsed.heardText || fallbackTranscript || "").trim(),
          intent: intentVal,
          executionTier: inferredTier,
          targetProjectCwd: String(parsed.targetProjectCwd || "").trim(),
          targetThreadId: String(parsed.targetThreadId || "").trim(),
          provider: String(parsed.provider || "").trim(),
          model: String(parsed.model || "").trim(),
          dispatchMode: rawDispatchMode === "immediate" || rawDispatchMode === "queue" ? rawDispatchMode : "",
          instruction: String(parsed.instruction || "").trim(),
          requestId: String(parsed.requestId || "").trim(),
          decision: String(parsed.decision || "").trim(),
          spokenReply: stripSpeechNoise(parsed.spokenReply || "", 360),
        };
      }
    } catch {
      // Try next extraction candidate.
    }
  }

  const spokenFallback = stripSpeechNoise(raw, 280);
  return {
    heardText: String(fallbackTranscript || "").trim(),
    intent: "summarize_progress",
    executionTier: "self_simple",
    targetProjectCwd: "",
    targetThreadId: "",
    provider: "",
    dispatchMode: "",
    instruction: "",
    requestId: "",
    decision: "",
    spokenReply: spokenFallback,
  };
}

function pickLatestAssistantSnippet(threadReadResult) {
  const turns = threadReadResult?.thread?.turns || [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const items = Array.isArray(turns[i]?.items) ? turns[i].items : [];
    for (let j = items.length - 1; j >= 0; j -= 1) {
      const item = items[j];
      if (!item || item.type !== "agentMessage" || !item.text) continue;
      if (item.phase === "commentary") continue;
      const clean = stripSpeechNoise(item.text, 160);
      if (clean) return clean;
    }
  }
  return "";
}

function normCwd(cwd = "") {
  const raw = String(cwd || "").trim().replace(/\\/g, "/");
  if (!raw || raw === "/") return raw;
  return raw.replace(/\/+$/, "");
}

function extractVoiceSearchTerms(text = "") {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return [];
  const terms = new Set();
  for (const m of raw.matchAll(/[a-z0-9][a-z0-9._-]{1,}/g)) {
    terms.add(m[0]);
  }
  for (const m of raw.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const seq = m[0];
    if (seq.length <= 6) terms.add(seq);
    for (let i = 0; i <= seq.length - 2; i += 1) {
      terms.add(seq.slice(i, i + 2));
    }
  }
  return [...terms];
}

export function resolveFuzzyVoiceTarget(plan = {}, snapshot = {}) {
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  const rawCwd = normCwd(normalizeSpokenChineseText(plan?.targetProjectCwd || ""));
  const rawThreadId = normalizeSpokenChineseText(plan?.targetThreadId || "").trim();
  const rawHeard = normalizeSpokenChineseText(plan?.heardText || "").trim();

  const cwdHintLow = rawCwd.toLowerCase();
  const threadHintLow = rawThreadId.toLowerCase();
  const heardLow = rawHeard.toLowerCase();
  const heardTerms = extractVoiceSearchTerms(`${rawCwd} ${rawThreadId} ${rawHeard}`);

  const scoreThread = (p, t) => {
    const idLow = String(t?.id || "").toLowerCase();
    const titleLow = String(t?.title || "").toLowerCase().trim();
    let score = 0;
    if (threadHintLow && (idLow.endsWith(`:${threadHintLow}`) || idLow.includes(threadHintLow))) {
      score += 120;
    }
    if (threadHintLow && titleLow && (titleLow.includes(threadHintLow) || threadHintLow.includes(titleLow))) {
      score += 90;
    }
    if (titleLow.length >= 2 && heardLow.includes(titleLow)) {
      score += 65 + Math.min(30, titleLow.length * 2);
    } else if (titleLow) {
      for (const term of heardTerms) {
        if (titleLow.includes(term)) score += term.length >= 3 ? 16 : 8;
      }
    }
    if (score > 0) {
      score += (t.live ? 4 : 0) + (t.pendingCount ? 4 : 0) + (p.pinned ? 3 : 0);
    }
    return score;
  };

  const pickBestThreadInProject = (p) => {
    let best = null;
    for (const t of p?.threads || []) {
      const score = scoreThread(p, t);
      if (score > 0 && (!best || score > best.score)) {
        best = { project: p, thread: t, score };
      }
    }
    return best;
  };

  // 1. 精确 ID / CWD 匹配
  if (rawThreadId) {
    for (const p of projects) {
      const hitThread = (p.threads || []).find((t) => t.id === rawThreadId);
      if (hitThread) {
        return { project: p, thread: hitThread, cwd: p.cwd, threadId: hitThread.id, exact: true };
      }
    }
  }
  if (rawCwd) {
    const hitProj = projects.find((p) => normCwd(p.cwd) === rawCwd);
    if (hitProj) {
      const hitThread = (hitProj.threads || []).find((t) => t.id === rawThreadId)
        || pickBestThreadInProject(hitProj)?.thread
        || null;
      return {
        project: hitProj,
        thread: hitThread,
        cwd: hitProj.cwd,
        threadId: hitThread?.id || rawThreadId || hitProj.threads?.[0]?.id || "",
        exact: true,
      };
    }
  }

  // 2. 模糊回退：当 Hydrogen 传了短名/近似路径或仅在 heardText 点名项目/会话时
  let bestThreadMatch = null;
  for (const p of projects) {
    const candidate = pickBestThreadInProject(p);
    if (candidate && (!bestThreadMatch || candidate.score > bestThreadMatch.score)) {
      bestThreadMatch = candidate;
    }
  }

  let bestProjectMatch = null;
  for (const p of projects) {
    const base = basename(normCwd(p.cwd) || "").toLowerCase();
    const nameLow = String(p.name || "").toLowerCase().trim();
    const aliasLow = String(p.alias || "").toLowerCase().trim();
    const fullCwdLow = normCwd(p.cwd).toLowerCase();
    const labels = [aliasLow, nameLow, base].filter((s) => s.length >= 2);
    let score = 0;

    if (cwdHintLow) {
      if (labels.some((lbl) => lbl === cwdHintLow) || fullCwdLow.endsWith(`/${cwdHintLow}`)) {
        score += 120;
      } else if (labels.some((lbl) => lbl.includes(cwdHintLow) || cwdHintLow.includes(lbl)) || fullCwdLow.includes(cwdHintLow)) {
        score += 85;
      }
    }
    for (const lbl of labels) {
      if (heardLow.includes(lbl)) {
        score += 55 + Math.min(25, lbl.length * 2);
      }
    }
    if (score === 0 && heardTerms.length) {
      for (const term of heardTerms) {
        if (labels.some((lbl) => lbl.includes(term))) {
          score += term.length >= 3 ? 18 : 9;
        }
      }
    }
    if (score > 0) {
      score += (p.pinned ? 6 : 0) + (p.liveCount ? 4 : 0) + (p.pendingCount ? 4 : 0);
      if (!bestProjectMatch || score > bestProjectMatch.score) {
        bestProjectMatch = { project: p, score };
      }
    }
  }

  if (bestProjectMatch && bestProjectMatch.score >= 18) {
    const p = bestProjectMatch.project;
    const inProjectThread = pickBestThreadInProject(p);
    if (inProjectThread) {
      return {
        project: p,
        thread: inProjectThread.thread,
        cwd: p.cwd,
        threadId: inProjectThread.thread.id,
        exact: false,
      };
    }
    if (!cwdHintLow && bestThreadMatch && bestThreadMatch.score >= 24 && bestThreadMatch.score > bestProjectMatch.score) {
      return {
        project: bestThreadMatch.project,
        thread: bestThreadMatch.thread,
        cwd: bestThreadMatch.project.cwd,
        threadId: bestThreadMatch.thread.id,
        exact: false,
      };
    }
    return {
      project: p,
      thread: p.threads?.[0] || null,
      cwd: p.cwd,
      threadId: p.threads?.[0]?.id || "",
      exact: false,
    };
  }
  if (bestThreadMatch && bestThreadMatch.score >= 24) {
    return {
      project: bestThreadMatch.project,
      thread: bestThreadMatch.thread,
      cwd: bestThreadMatch.project.cwd,
      threadId: bestThreadMatch.thread.id,
      exact: false,
    };
  }

  return {
    project: null,
    thread: null,
    cwd: rawCwd.startsWith("/") ? rawCwd : "",
    threadId: rawThreadId,
    exact: false,
  };
}

function summarizeFallbackBriefing(snapshot, { askResult = false } = {}) {
  const parts = [];
  const completedResults = Array.isArray(snapshot?.completedResults) ? snapshot.completedResults : [];
  if (askResult && completedResults.length > 0) {
    const latest = completedResults[0];
    const label = latest.projectName || latest.title || "外部任务";
    const body = stripSpeechNoise(latest.lastResultSummary || "", 180);
    if (body) {
      parts.push(`「${label}」的结果是：${body}`);
    } else {
      parts.push(`「${label}」已完成，暂时没有提取到详细文本摘要。`);
    }
    if (completedResults.length > 1) {
      const second = completedResults[1];
      const secondBody = stripSpeechNoise(second.lastResultSummary || "", 120);
      if (secondBody) {
        parts.push(`另外「${second.projectName || second.title || "任务"}」的结果是：${secondBody}`);
      }
    }
  }
  if (snapshot.pendingRequests?.length) {
    const first = snapshot.pendingRequests[0];
    parts.push(`当前有 ${snapshot.pendingRequests.length} 项待确认，第一项是${stripSpeechNoise(first.title || first.command || "权限审批", 60)}。`);
  }
  const running = (snapshot.projects || []).filter((p) => p.liveCount > 0);
  if (running.length) {
    const names = running.slice(0, 3).map((p) => p.alias || p.name).join("、");
    parts.push(`${names} 正在运行中。`);
  }
  if (!askResult && completedResults.length > 0 && parts.length < 2) {
    const latest = completedResults[0];
    const body = stripSpeechNoise(latest.lastResultSummary || "", 140);
    if (body) {
      parts.push(`最近完成的「${latest.projectName || latest.title || "任务"}」结果为：${body}`);
    }
  }
  const focus = (snapshot.projects || []).slice(0, 2).find((p) => p.threads?.length);
  if (focus && !running.length && !snapshot.pendingRequests?.length && !completedResults.length) {
    const t = focus.threads[0];
    parts.push(`最近活跃项目是${focus.alias || focus.name}，最新对话《${t.title}》${t.preview ? `，进展为${t.preview}` : ""}。`);
  }
  if (!parts.length) {
    return "目前没有运行中的任务或待确认请求，你可以随时告诉我项目名称或直接下达新任务。";
  }
  return parts.join(" ");
}

export function summarizeProjectBriefing(project, snapshot, { askResult = false } = {}) {
  if (!project) return summarizeFallbackBriefing(snapshot, { askResult });
  const threadIds = new Set((project.threads || []).map((t) => t.id));
  const pending = (snapshot?.pendingRequests || []).filter(
    (r) => r.projectCwd === project.cwd || threadIds.has(r.threadId),
  );
  const running = (project.threads || []).filter((t) => t.live);
  const completedMatches = (snapshot?.completedResults || []).filter(
    (r) => r.projectCwd === project.cwd || threadIds.has(r.threadId),
  );
  const parts = [];
  if (askResult && completedMatches.length > 0 && completedMatches[0].lastResultSummary) {
    parts.push(`${project.name}刚完成的结果是：${stripSpeechNoise(completedMatches[0].lastResultSummary, 160)}。`);
  }
  if (pending.length) {
    parts.push(`${project.name}有 ${pending.length} 项待确认，比如：${pending[0].question || pending[0].title || pending[0].threadTitle || pending[0].command || "操作审批"}。`);
  }
  if (running.length) {
    parts.push(`${project.name}当前有 ${running.length} 个任务运行中，最新是「${running[0].title || "新任务"}」，状态：${running[0].phase || running[0].preview || "执行中"}。`);
  }
  if (!askResult && !running.length && completedMatches.length > 0 && completedMatches[0].lastResultSummary) {
    parts.push(`${project.name}最近已完成，结果为：${stripSpeechNoise(completedMatches[0].lastResultSummary, 160)}。`);
  }
  const latest = project.threads?.[0];
  if (!parts.length && latest) {
    parts.push(`${project.name}目前空闲，最近一条会话是「${latest.title || "新会话"}」${latest.preview ? `，${stripSpeechNoise(latest.preview, 70)}` : ""}。`);
  }
  if (!parts.length) {
    parts.push(`${project.name}目前没有活跃任务。`);
  }
  return parts.join(" ");
}

export function detectSpokenRoute(text = "") {
  const s = normalizeSpokenChineseText(text);
  if (/(协调者|orchestrator|carbon)/i.test(s) && !/hydrogen/i.test(s)) {
    return {
      provider: "antigravity",
      model: DEFAULT_AGY_MODEL,
      explicitHeavy: true,
      explicitFastHydrogen: false,
    };
  }
  if (/(hydrogen|氢模型|快速模型|极速模型|低延迟)/i.test(s)) {
    return {
      provider: "antigravity",
      model: "",
      explicitHeavy: false,
      explicitFastHydrogen: true,
    };
  }
  if (/\bcodex\b/i.test(s)) {
    return { provider: "codex", model: "", explicitHeavy: false, explicitFastHydrogen: false };
  }
  if (/\bclaude\b/i.test(s)) {
    return { provider: "claude", model: "", explicitHeavy: false, explicitFastHydrogen: false };
  }
  if (/\b(antigravity|agy)\b|反重力/i.test(s)) {
    return {
      provider: "antigravity",
      model: "",
      explicitHeavy: false,
      explicitFastHydrogen: true,
    };
  }
  return { provider: "", model: "", explicitHeavy: false, explicitFastHydrogen: false };
}

function detectSpokenProvider(text = "") {
  return detectSpokenRoute(text).provider;
}

/**
 * 区分语音下发指令是立即发送（直出结果/停止等待/不排队）还是常规排队。
 */
export function detectVoiceDispatchMode(text = "") {
  const clean = normalizeSpokenChineseText(text).trim();
  if (!clean) {
    return { dispatchMode: "queue", immediate: false, reason: "default_queue" };
  }
  if (/(?:排到后面|排队执行|排队处理|先排队|排个队|等当前(?:任务|回合|这轮)?(?:完成|结束)|等(?:它|他|上一轮)?忙完|等这轮结束)/i.test(clean)) {
    return { dispatchMode: "queue", immediate: false, reason: "explicit_queue" };
  }
  if (
    /(?:直接(?:出|给|返回|输出|汇报|总结|回答|给出|给个|给我)(?:最终|当前)?(?:结果|结论|答案|答复|方案|总结)|(?:先|快|马上|立刻)?(?:给|出|说|汇报|总结)(?:个|一下)?(?:最终|当前)?(?:结果|结论|答案)|停止等待|别等了|不用等了|不要等了|别再等了|不等了|先停(?:下|一下)?[，,:：\s]*(?:直接|给|出|说|汇报|总结|回答)|别(?:跑|查|找|搜|改|等|试)了[，,:：\s]*(?:直接|先|给|出|说|汇报|总结|回答))/i.test(clean)
  ) {
    return { dispatchMode: "immediate", immediate: true, reason: "direct_result_or_stop_waiting" };
  }
  if (
    /(?:立即发送|马上发送|立刻发送|立即执行|马上执行|立刻执行|别排队|不要排队|不用排队|跳过排队|插队|插话(?:发|告诉|让他|叫他|说)?|现在就(?:发|执行|处理|停下|总结|给)|直接发过去)/i.test(clean)
  ) {
    return { dispatchMode: "immediate", immediate: true, reason: "explicit_immediate_send" };
  }
  return { dispatchMode: "queue", immediate: false, reason: "default_queue" };
}

const HEAVY_SELF_TASK_RE = /(?:分析一下|深入(?:分析|整理|查|总结|梳理)|仔细(?:查|看|检查)|排查(?:一下|原因|为什么)|原因是什么|为什么会(?:报错|失败|卡住)|定位一下(?:问题|原因)|写一份|生成一份|起草|整理(?:一份|成|出)|梳理(?:一下|出)|汇总成|写个(?:总结|周报|方案|排查)|对比(?:一下)?|区别在哪|方案(?:怎么选|推荐)|评估一下|复盘一下|详细(?:总结|介绍|汇报|梳理|分析|看看|查一下)|总结(?:一下|出)?(?:刚才|所有|最近).*(?:改动|做了什么|问题|报错|内容|原因))/i;

/**
 * 区分语音指令执行层级：
 * - self_simple: 简单问答/控制面状态查询/开项目/审批/重播，由语音主脑直接完成
 * - subagent_hydrogen: 自己可做但有耗时的分析/梳理/排查/对比任务，开启 Hydrogen 子代理异步完成并持续反馈
 * - external_thread: 需要交由其他项目或会话执行的任务
 */
export function classifyVoiceExecutionTier(text = "", { plan = null, matchedProject = null } = {}) {
  const intent = String(plan?.intent || "").trim();
  if (intent === "subagent_hydrogen") {
    return { tier: "subagent_hydrogen", reason: "subagent_hydrogen_intent" };
  }
  if (intent === "send_turn" || intent === "create_thread" || intent === "interrupt_thread") {
    return { tier: "external_thread", reason: `external_${intent}` };
  }
  if (["no_speech", "wake_ping", "repeat_last", "open_project", "open_thread", "approve_request"].includes(intent)) {
    return { tier: "self_simple", reason: `simple_${intent}` };
  }
  const clean = normalizeSpokenChineseText(text).trim();
  if (!clean) {
    return { tier: "self_simple", reason: "empty_text" };
  }
  const explicitExternalVerb = /^(?:让|叫|通知|告诉|给)\s*\S+/.test(clean)
    || /(?:新建|新开|创建|开个|开一个).*(?:会话|任务|对话|线程)/i.test(clean);
  if (explicitExternalVerb || (matchedProject && /(?:去|跑一下|运行|修一下|修复|修改|写一下|测一下|部署|构建)/.test(clean))) {
    return { tier: "external_thread", reason: "explicit_external_delegation" };
  }
  if (HEAVY_SELF_TASK_RE.test(clean)) {
    return { tier: "subagent_hydrogen", reason: "heavy_self_cognitive_task" };
  }
  return { tier: "self_simple", reason: "simple_direct_query" };
}

function normalizeFuzzyKey(value = "") {
  return normalizeSpokenChineseText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeHomophoneText(value = "") {
  return normalizeSpokenChineseText(value)
    .replace(/[展占战]/g, "站")
    .replace(/[险鲜]/g, "显")
    .replace(/宝/g, "包")
    .replace(/[治智制]/g, "制");
}

function extractHanSubAliases(key = "") {
  if (!/^[\u4e00-\u9fff]{4,}$/.test(key)) return [];
  const subs = [];
  for (let len = key.length - 1; len >= 3; len -= 1) {
    subs.push(key.slice(0, len));
    subs.push(key.slice(key.length - len));
  }
  return [...new Set(subs)];
}

function matchBestProjectInText(text = "", snapshot = {}) {
  const normalizedText = normalizeSpokenChineseText(text);
  const cleanText = normalizeFuzzyKey(normalizedText);
  if (!cleanText) return null;
  const homophoneRaw = normalizeHomophoneText(normalizedText).toLowerCase();
  const homophoneClean = normalizeFuzzyKey(homophoneRaw);
  let best = null;
  let bestScore = 0;

  for (const p of snapshot?.projects || []) {
    const candidates = [p.alias, p.name, basename(p.cwd || "")].filter(Boolean);
    const boost = (p.pinned ? 4 : 0) + (p.liveCount > 0 ? 2 : 0);
    for (const cand of candidates) {
      const normCand = normalizeSpokenChineseText(cand);
      const key = normalizeFuzzyKey(normCand);
      if (key.length < 2) continue;

      if (cleanText.includes(key)) {
        const score = key.length * 10 + boost;
        if (score > bestScore) {
          bestScore = score;
          best = { project: p, matchedAlias: cand, matchedFragment: cand };
        }
        continue;
      }

      const keyHomo = normalizeFuzzyKey(normalizeHomophoneText(normCand));
      if (keyHomo.length >= 3 && homophoneClean.includes(keyHomo)) {
        const idx = homophoneRaw.indexOf(normalizeHomophoneText(normCand).toLowerCase());
        const surface = idx >= 0 ? normalizedText.slice(idx, idx + normCand.length) : cand;
        const score = keyHomo.length * 8 + boost;
        if (score > bestScore) {
          bestScore = score;
          best = { project: p, matchedAlias: cand, matchedFragment: surface };
        }
        continue;
      }

      for (const sub of extractHanSubAliases(key)) {
        if (cleanText.includes(sub)) {
          const score = sub.length * 7 + boost;
          if (score > bestScore) {
            bestScore = score;
            best = { project: p, matchedAlias: cand, matchedFragment: sub };
          }
          break;
        }
        const subHomo = normalizeHomophoneText(sub);
        if (homophoneClean.includes(subHomo)) {
          const idx = homophoneRaw.indexOf(subHomo);
          const surface = idx >= 0 ? normalizedText.slice(idx, idx + sub.length) : sub;
          const score = sub.length * 6 + boost;
          if (score > bestScore) {
            bestScore = score;
            best = { project: p, matchedAlias: cand, matchedFragment: surface };
          }
          break;
        }
      }
    }
  }
  return best;
}

function stripMatchedProjectFromInstruction(raw = "", matchedAlias = "", matchedFragment = "") {
  let out = normalizeSpokenChineseText(raw).trim();
  for (const token of [matchedAlias, matchedFragment]) {
    if (!token) continue;
    const normToken = normalizeSpokenChineseText(token).trim();
    if (!normToken) continue;
    const escaped = normToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "ig"), " ");
  }
  out = out
    .replace(/^(?:请|麻烦)?(?:帮我|让|叫|给|告诉|在|把|切到|切换|打开)?\s*(?:这个|那个)?\s*(?:项目|工程|仓库|目录|对话|会话|这边)?\s*[，,:：]?\s*/i, "")
    .replace(/^(?:去|继续|执行|处理|做一下)?\s*[，,:：]?\s*/, "")
    .trim();
  return out;
}

export function classifyNonActionableSpeech(text = "", { hasPending = false } = {}) {
  const clean = normalizeSpokenChineseText(text).trim();
  if (!clean || /^[\p{P}\p{S}\s]+$/u.test(clean)) {
    return { noSpeech: true, reason: "empty_or_punctuation" };
  }
  if (/^(?:\[[^\]]{1,24}\]|\([^)]{1,24}\)|（[^）]{1,24}）|【[^】]{1,24}】|♪.*♪)+$/u.test(clean)) {
    return { noSpeech: true, reason: "sound_tag" };
  }
  if (
    /(字幕|请订阅|点赞订阅|感谢收看|感谢观看|谢谢观看|谢谢大家|优优独播剧场|明镜与点点|amara\.org|subtitles\s+by|thanks\s+for\s+watching|thank\s+you\s+for\s+watching|please\s+subscribe|软件开发与项目管理语音指令|以下是普通话|普通话或英文语音)/i.test(clean)
    && !/(进度|状态|批准|拒绝|停止|中断|新建|打开|切换|切到|重播|再说)/.test(clean)
  ) {
    return { noSpeech: true, reason: "asr_hallucination" };
  }
  const bare = clean.replace(/[\p{P}\p{S}\s]+/gu, "");
  if (!bare) {
    return { noSpeech: true, reason: "empty_or_punctuation" };
  }
  if (/^喂+$/i.test(bare)) {
    return { noSpeech: false, reason: "" };
  }
  if (bare.length <= 1) {
    return { noSpeech: true, reason: "single_char_noise" };
  }
  if (hasPending && /^(?:好|好的|行|可以|没问题|确认|通过|同意|允许|批准|拒绝|驳回|不同意|ok|okay|yes|approve|reject)$/i.test(bare)) {
    return { noSpeech: false, reason: "" };
  }
  if (/^(?:嗯+|啊+|哦+|呃+|额+|唉+|哎+|哼+|呼+|哈+|呵+|嘿+|嗯哼|啊这|这个|那个|就是|然后|是吗|对吧|行吧|好吧|好|好的|行|可以|对|是的|没问题|没事|没啥|算了|不用了|没关系|等一下|稍等|我看看|先这样|谢谢|谢谢你|thank\s*you|thanks|okay|ok|yes|no|yeah|um+|uh+|ah+|oh+|hm+|hmm+|you|the|bye)$/i.test(bare)) {
    return { noSpeech: true, reason: "backchannel_or_filler" };
  }
  return { noSpeech: false, reason: "" };
}

export function buildDeterministicVoicePlan({
  transcript = "",
  snapshot = {},
  activeThreadId = "",
  mode = "turn",
  lastUtterance = null,
  unheardUtterances = [],
} = {}) {
  const clean = normalizeSpokenChineseText(transcript).trim();
  const route = detectSpokenRoute(clean);
  const dispatchModeInfo = detectVoiceDispatchMode(clean);
  const basePlan = {
    heardText: clean,
    intent: "summarize_progress",
    executionTier: "self_simple",
    targetProjectCwd: "",
    targetThreadId: "",
    provider: "",
    model: "",
    explicitFastHydrogen: false,
    dispatchMode: "",
    dispatchModeReason: "",
    instruction: "",
    requestId: "",
    decision: "",
    spokenReply: "",
  };

  if (mode === "briefing") {
    return {
      ...basePlan,
      heardText: clean || "播报当前任务进度",
      spokenReply: summarizeFallbackBriefing(snapshot, { askResult: true }),
    };
  }

  const pending = snapshot?.pendingRequests || [];
  const noiseCheck = classifyNonActionableSpeech(clean, { hasPending: pending.length > 0 });
  if (noiseCheck.noSpeech) {
    return {
      ...basePlan,
      heardText: "",
      ignoredText: clean,
      intent: "no_speech",
      noSpeech: true,
      silenceReason: noiseCheck.reason,
      spokenReply: "",
    };
  }

  if (isRepeatVoiceIntent(clean)) {
    const unheardList = Array.isArray(unheardUtterances)
      ? unheardUtterances.filter((u) => String(u?.text || "").trim())
      : [];
    let spokenReply = "";
    if (unheardList.length > 0) {
      const recent = unheardList.slice(-2).map((u) => stripSpeechNoise(u.text, 150)).filter(Boolean);
      spokenReply = stripSpeechNoise(`重新播报刚才未听到的内容：${recent.join("；")}`, 360);
    } else if (String(lastUtterance?.text || "").trim()) {
      spokenReply = stripSpeechNoise(`刚才说的是：${String(lastUtterance.text).trim()}`, 360);
    } else {
      spokenReply = stripSpeechNoise(`刚才还没有播报记录。${summarizeFallbackBriefing(snapshot)}`, 360);
    }
    return {
      ...basePlan,
      intent: "repeat_last",
      executionTier: "self_simple",
      spokenReply,
    };
  }

  const matched = matchBestProjectInText(clean, snapshot);
  const project = matched?.project || null;
  const projectThreads = project?.threads || [];
  const preferredThread = (route.explicitFastHydrogen
    ? projectThreads.find((t) => t.provider === "antigravity" && /hydrogen/i.test(t.model || ""))
      || projectThreads.find((t) => t.provider === "antigravity" && t.live)
      || projectThreads.find((t) => t.provider === "antigravity")
    : null)
    || projectThreads.find((t) => t.live)
    || projectThreads[0]
    || null;
  const provider = route.provider || detectSpokenProvider(clean);
  const allThreads = Array.isArray(snapshot?.threads) && snapshot.threads.length
    ? snapshot.threads
    : (snapshot?.projects || []).flatMap((p) =>
      (p.threads || []).map((t) => ({ ...t, cwd: t.cwd || p.cwd })),
    );
  const activeThread = allThreads.find((t) => t.id === (activeThreadId || snapshot?.activeThreadId));
  const askResultCue = /(什么结果|结果怎么样|有结果了吗|做完了吗|什么结论|结果是什么|刚才.*结果|完成的结果)/i.test(clean);

  // 1. Reject pending request
  if (/(拒绝|不同意|驳回|不批准|别执行|decline|reject)/i.test(clean) && !/(批准|同意)/.test(clean)) {
    const req = (project && pending.find((r) => r.projectCwd === project.cwd)) || pending[0];
    return {
      ...basePlan,
      intent: "approve_request",
      executionTier: "self_simple",
      targetProjectCwd: req?.projectCwd || project?.cwd || "",
      targetThreadId: req?.threadId || "",
      requestId: req?.requestId || "",
      decision: "decline",
      spokenReply: req ? "好的，已拒绝这条待确认请求。" : "当前没有待确认的请求。",
    };
  }

  // 2. Approve pending request
  const isApprovalWord = /(批准|同意|通过审批|确认执行|允许执行|approve)/i.test(clean)
    || (pending.length > 0 && /^(好|好的|行|可以|没问题|确认|通过|同意|允许)[。！!.,]*$/.test(clean));
  if (isApprovalWord) {
    const req = (project && pending.find((r) => r.projectCwd === project.cwd)) || pending[0];
    return {
      ...basePlan,
      intent: "approve_request",
      executionTier: "self_simple",
      targetProjectCwd: req?.projectCwd || project?.cwd || "",
      targetThreadId: req?.threadId || "",
      requestId: req?.requestId || "",
      decision: "accept",
      spokenReply: req ? `好的，已批准${req.projectName ? `${req.projectName}的` : ""}待确认操作。` : "当前没有等待确认的请求。",
    };
  }

  // 3. Interrupt task (unless user asked agent to stop waiting and immediately output results/follow-up)
  const asksForAgentOutput = dispatchModeInfo.reason === "direct_result_or_stop_waiting"
    || /(?:直接(?:出|给|返回|输出|汇报|总结|回答)|给出(?:结果|结论)|汇报(?:结果|结论)|总结一下)/.test(clean);
  if (!asksForAgentOutput && /(中断|停止运行|停一下|别跑了|暂停任务|interrupt)/i.test(clean)) {
    const runningTarget = (project && projectThreads.find((t) => t.live))
      || (activeThread?.live ? activeThread : null)
      || allThreads.find((t) => t.live);
    if (runningTarget) {
      return {
        ...basePlan,
        intent: "interrupt_thread",
        executionTier: "external_thread",
        targetProjectCwd: runningTarget.cwd || "",
        targetThreadId: runningTarget.id || "",
        spokenReply: `好的，正在中断「${runningTarget.title || "当前任务"}」。`,
      };
    }
    return {
      ...basePlan,
      executionTier: "self_simple",
      spokenReply: "目前没有正在运行的任务。",
    };
  }

  // 4. Create a new thread (explicitly delegate a new session to another project/provider)
  if (/(新建|新开|创建|开个|开一个).*(会话|任务|对话|线程)/i.test(clean)) {
    const fallbackProject = project
      || (activeThread ? (snapshot?.projects || []).find((p) => p.cwd === activeThread.cwd) : null)
      || (snapshot?.projects || [])[0];
    const promptPart = clean
      .replace(/^.*?(?:会话|任务|对话|线程)\s*[，,:：]?\s*(?:去|帮我|做|执行|内容是)?\s*/, "")
      .trim();
    return {
      ...basePlan,
      intent: "create_thread",
      executionTier: "external_thread",
      targetProjectCwd: fallbackProject?.cwd || "",
      provider,
      model: route.model,
      explicitFastHydrogen: route.explicitFastHydrogen,
      instruction: promptPart || clean,
      spokenReply: fallbackProject
        ? `好的，已在${fallbackProject.name}新建任务并交付执行${promptPart ? `：${stripSpeechNoise(promptPart, 40)}` : ""}。`
        : "没有找到可用项目目录来新建任务。",
    };
  }

  const tierInfo = classifyVoiceExecutionTier(clean, { matchedProject: project });

  // 5. Project-targeted voice commands (delegation or simple project lookup/open)
  if (project) {
    const remainder = stripMatchedProjectFromInstruction(clean, matched.matchedAlias, matched.matchedFragment);
    const hasExplicitOpenVerb = /^(?:请|麻烦|帮我|我想|我要|现在)?\s*(?:打开|切到|切换|进入|跳转|过去看下|去看)/.test(clean);
    const hasStatusKeyword = /(什么进度|进度怎么样|什么结果|结果怎么样|有结果了吗|怎么样了|现在怎么样|弄好了吗|好了吗|好了没|搞定了吗|搞定没|跑完了吗|忙完了吗|还在跑吗|在忙什么|状态|完成了吗|在干嘛|在做什么|什么情况|汇报|播报|如何)/.test(clean);
    const isOpenOnly = !hasStatusKeyword && !dispatchModeInfo.immediate && (
      (hasExplicitOpenVerb && (!remainder || /^(?:项目|会话|对话|主页|看看|打开|切过去|进去|查看)+[。！!]*$/.test(remainder)))
      || (!hasExplicitOpenVerb && Boolean(remainder) && /^(?:看看|打开|切过去|进去|查看)[。！!]*$/.test(remainder))
    );
    const isStatusQuery = !dispatchModeInfo.immediate && tierInfo.tier !== "subagent_hydrogen" && ((!isOpenOnly && !remainder) || hasStatusKeyword);

    if (isOpenOnly) {
      return {
        ...basePlan,
        intent: "open_project",
        executionTier: "self_simple",
        targetProjectCwd: project.cwd,
        targetThreadId: preferredThread?.id || "",
        spokenReply: `已切换到${project.name}。${preferredThread ? `当前会话是「${preferredThread.title || "新会话"}」。` : ""}`,
      };
    }

    if (isStatusQuery && !/^(?:让|叫|告诉|去|运行|执行|测试|修改|修复|检查|帮我)/.test(clean)) {
      return {
        ...basePlan,
        intent: "summarize_progress",
        executionTier: "self_simple",
        targetProjectCwd: project.cwd,
        targetThreadId: preferredThread?.id || "",
        spokenReply: summarizeProjectBriefing(project, snapshot, { askResult: askResultCue }),
      };
    }

    if (tierInfo.tier === "subagent_hydrogen" && !/^(?:让|叫|通知|告诉|给)\s*/.test(clean) && !dispatchModeInfo.immediate) {
      return {
        ...basePlan,
        intent: "subagent_hydrogen",
        executionTier: "subagent_hydrogen",
        targetProjectCwd: project.cwd,
        targetThreadId: preferredThread?.id || "",
        provider: "antigravity",
        model: route.model,
        explicitFastHydrogen: true,
        instruction: clean,
        spokenReply: `好的，关于${project.name}的分析我先开一个 Hydrogen 子代理帮你处理，过程中会持续告诉你进展，有结果也第一时间反馈。`,
      };
    }

    const instruction = remainder || clean;
    const isImmediate = dispatchModeInfo.immediate;
    return {
      ...basePlan,
      intent: "send_turn",
      executionTier: "external_thread",
      targetProjectCwd: project.cwd,
      targetThreadId: preferredThread?.id || "",
      provider,
      model: route.model,
      explicitFastHydrogen: route.explicitFastHydrogen,
      dispatchMode: dispatchModeInfo.dispatchMode,
      dispatchModeReason: dispatchModeInfo.reason,
      instruction,
      spokenReply: isImmediate
        ? `好的，立即发送给${project.name}：${stripSpeechNoise(instruction, 40)}。`
        : `好的，已发给${project.name}处理：${stripSpeechNoise(instruction, 40)}。`,
    };
  }

  // 6. Heavy self-doable task without delegating to another session -> Hydrogen subagent
  if (tierInfo.tier === "subagent_hydrogen" && !dispatchModeInfo.immediate && !/^(?:让当前(?:对话|会话|任务)?|给当前(?:对话|会话|任务)?)/.test(clean)) {
    return {
      ...basePlan,
      intent: "subagent_hydrogen",
      executionTier: "subagent_hydrogen",
      targetProjectCwd: activeThread?.cwd || "",
      targetThreadId: activeThreadId || snapshot?.activeThreadId || "",
      provider: route.provider || "",
      model: route.model,
      explicitFastHydrogen: route.explicitFastHydrogen,
      instruction: clean,
      spokenReply: "好的，这个需要一点时间处理，我先开一个 Hydrogen 子代理帮你做，过程中会持续同步进展，有结果马上反馈给你。",
    };
  }

  // 7. General progress/status/result consultation (simple local lookup)
  if (!dispatchModeInfo.immediate && /(进度|状态|汇总|汇报|播报|概览|情况|待确认|完成|卡在哪|在干嘛|有什么任务|多少个|什么结果|结果怎么样|有结果了吗|结果是什么|结论|怎么样了|现在怎么样|弄好了吗|好了吗|好了没|搞定了吗|搞定没|跑完了吗|忙完了吗|还在跑吗|在忙什么)/.test(clean)) {
    return {
      ...basePlan,
      executionTier: "self_simple",
      spokenReply: summarizeFallbackBriefing(snapshot, { askResult: askResultCue }),
    };
  }

  // 8. Follow-up or immediate instruction targeting current active/running thread (delegated to external session)
  const liveThread = allThreads.find((t) => t.live) || null;
  const targetId = activeThreadId || snapshot?.activeThreadId || liveThread?.id || "";
  const isImmediateCurrent = dispatchModeInfo.immediate;
  if (targetId && (isImmediateCurrent || /^(?:让当前(?:对话|会话|任务)?|继续|帮我|请帮我|给当前|发送|执行|跑一下|查一下|修改|修复|测试|检查)/.test(clean))) {
    const inst = clean.replace(/^(?:让当前(?:对话|会话|任务)?|给当前(?:对话|会话|任务)?|发送)\s*[，,:：]?\s*/, "").trim() || clean;
    const targetThreadObj = allThreads.find((t) => t.id === targetId);
    return {
      ...basePlan,
      intent: "send_turn",
      executionTier: "external_thread",
      targetProjectCwd: targetThreadObj?.cwd || "",
      targetThreadId: targetId,
      provider,
      model: route.model,
      explicitFastHydrogen: route.explicitFastHydrogen,
      dispatchMode: dispatchModeInfo.dispatchMode,
      dispatchModeReason: dispatchModeInfo.reason,
      instruction: inst,
      spokenReply: isImmediateCurrent
        ? `好的，立即发送给当前对话：${stripSpeechNoise(inst, 40)}。`
        : `好的，已发给当前对话：${stripSpeechNoise(inst, 40)}。`,
    };
  }

  if (/(你在吗|^在吗[？?！!。]*$|能听到吗|听得到吗|听得见吗|喂.*在吗)/i.test(clean)) {
    return {
      ...basePlan,
      intent: "wake_ping",
      executionTier: "self_simple",
      spokenReply: "我在，请讲。",
    };
  }

  if (/^(?:你好|您好|哈喽|hello|hi|喂+|在不在|有声音吗|说话了吗|试音)[？?！!。,.，\s]*$/i.test(clean)
    || /(?:在不在|有声音吗|说话了吗|试音)/i.test(clean)) {
    return {
      ...basePlan,
      intent: "wake_ping",
      executionTier: "self_simple",
      spokenReply: "我在，声音正常，请讲。",
    };
  }

  const hasActionOrDomainCue = /(进度|状态|任务|项目|会话|对话|线程|审批|确认|请求|权限|继续|暂停|停止|中断|新建|新开|创建|打开|切换|切到|重播|再说|出结果|给结果|结果|结论|答案|排队|插队|插话|别等|停止等待|立即|立刻|马上|分析|梳理|整理|排查|对比|起草|写一份|评估|复盘|帮我|请|麻烦|跑|查|看|修|改|写|测|构建|部署|总结|汇报|播报|问题|报错|怎么样|好了|搞定|在忙|你好|在不在|有声音|说话了吗|试音|codex|claude|antigravity|agy|hydrogen|carbon|grok|agent|project|status|run|fix|test|open|check)/i.test(clean);
  if (!hasActionOrDomainCue) {
    return {
      ...basePlan,
      heardText: "",
      ignoredText: clean,
      intent: "no_speech",
      executionTier: "self_simple",
      noSpeech: true,
      silenceReason: "no_actionable_intent",
      spokenReply: "",
    };
  }

  return {
    ...basePlan,
    executionTier: "self_simple",
    spokenReply: `听到你说「${stripSpeechNoise(clean, 36)}」。${summarizeFallbackBriefing(snapshot)}`,
  };
}

export class VoiceCallService {
  #hub;
  #env;
  #dataDir;
  #workspaceDir;
  #utterancesDir;
  #execFile;
  #onEvent;
  #client = null;
  #clientAppDataDir = "";
  #initClientPromise = null;
  #modelsCache = null;
  #hubModelsCache = new Map();
  #calls = new Map();
  #callStates = new Map();
  #ttsCache = new Map();
  #pendingDispatchPromises = new Set();
  #activeSessionTurn = new Map();
  #activeSubagentSessions = new Map();
  #pendingSubagentThreads = new Map();
  #turnQueue = Promise.resolve();
  #subagentProgressIntervalMs = 18_000;
  #subagentMinFeedbackGapMs = 12_000;
  #subagentExecutor = null;
  #asrChild = null;
  #asrReadyPromise = null;
  #asrStdoutBuf = "";
  #asrPending = new Map();
  #closed = false;

  constructor({
    hub,
    env = process.env,
    dataDir = defaultDataDir(env),
    execFileImpl = execFileCrossPlatform,
    onEvent = null,
    subagentProgressIntervalMs = 18_000,
    subagentMinFeedbackGapMs = 12_000,
    subagentExecutor = null,
  } = {}) {
    this.#hub = hub;
    this.#env = env;
    this.#dataDir = dataDir;
    this.#workspaceDir = resolve(dataDir, "voice-call");
    this.#utterancesDir = resolve(this.#workspaceDir, "utterances");
    this.#execFile = execFileImpl;
    this.#onEvent = typeof onEvent === "function" ? onEvent : null;
    this.#subagentProgressIntervalMs = Math.max(50, Number(subagentProgressIntervalMs) || 18_000);
    this.#subagentMinFeedbackGapMs = Math.max(20, Number(subagentMinFeedbackGapMs) || 12_000);
    this.#subagentExecutor = typeof subagentExecutor === "function" ? subagentExecutor : null;
  }

  async resolveHydrogenModel() {
    const override = String(this.#env?.AGENT_CONTROL_VOICE_MODEL || "").trim();
    if (override) return override;
    if (!this.#modelsCache || Date.now() - this.#modelsCache.at > MODEL_CACHE_TTL_MS) {
      let items = [];
      try {
        items = await listAgyModelsFromCli({
          env: this.#env,
          execFileImpl: this.#execFile,
        });
      } catch {
        items = [];
      }
      if (Array.isArray(items) && items.length > 0) {
        this.#modelsCache = { at: Date.now(), items };
      } else {
        return pickPreferredHydrogenModel([...FALLBACK_AGY_MODELS]);
      }
    }
    return pickPreferredHydrogenModel(this.#modelsCache.items);
  }

  #hasLocalWhisperRuntime() {
    const explicitBin = String(this.#env?.VOICE_ASR_BIN || process.env.VOICE_ASR_BIN || "").trim();
    if (explicitBin) return true;
    if (process.platform !== "darwin") return false;
    const pyBin = String(this.#env?.VOICE_PYTHON_BIN || "").trim();
    if (pyBin) return existsSync(pyBin);
    return existsSync("/opt/homebrew/bin/python3.12") || existsSync("/usr/bin/python3");
  }

  async #listModelsForProviderSafe(provider) {
    const prov = String(provider || "").trim().toLowerCase();
    const cached = this.#hubModelsCache.get(prov);
    if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
      return cached.items;
    }
    let items = [];
    if (prov === "antigravity") {
      try {
        items = await Promise.race([
          listAgyModelsFromCli({ env: this.#env, execFileImpl: this.#execFile }),
          new Promise((res) => setTimeout(() => res([]), 1500)),
        ]);
      } catch {
        items = [];
      }
      if (!Array.isArray(items) || !items.length) {
        items = [...FALLBACK_AGY_MODELS];
      }
    } else if (typeof this.#hub?.listModels === "function") {
      try {
        const res = await Promise.race([
          this.#hub.listModels(prov),
          new Promise((res) => setTimeout(() => res(null), 1500)),
        ]);
        items = Array.isArray(res?.items) ? res.items : (Array.isArray(res) ? res : []);
      } catch {
        items = [];
      }
    }
    if (items.length > 0) {
      this.#hubModelsCache.set(prov, { at: Date.now(), items });
    }
    return items;
  }

  async #getInstalledVoiceProfiles() {
    if (typeof this.#hub?.listProvidersAndProfiles === "function") {
      try {
        const payload = await this.#hub.listProvidersAndProfiles();
        const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
        return profiles.filter((p) => p?.installed !== false && !p?.health?.disabled && p?.health?.status !== "unavailable");
      } catch {}
    }
    const agyProfiles = await discoverAntigravityProfiles({ env: this.#env }).catch(() => []);
    return agyProfiles.filter((p) => p?.installed !== false && !p?.health?.disabled);
  }

  async listVoiceModelOptions({
    voiceProvider = "",
    voiceModel = "",
    voiceProfileId = "",
  } = {}) {
    const installedProfiles = await this.#getInstalledVoiceProfiles();
    const byProvider = new Map();
    for (const p of installedProfiles) {
      const prov = String(p?.provider || "").toLowerCase();
      if (!prov || !VOICE_LIGHT_PROVIDER_PRIORITY.includes(prov)) continue;
      if (!byProvider.has(prov)) byProvider.set(prov, []);
      byProvider.get(prov).push(p);
    }

    const availableProviders = VOICE_LIGHT_PROVIDER_PRIORITY.filter((prov) => byProvider.has(prov));
    const modelsEntries = await Promise.all(
      availableProviders.map(async (prov) => [prov, await this.#listModelsForProviderSafe(prov)]),
    );
    const modelsByProvider = new Map(modelsEntries);

    const options = [
      {
        key: "auto",
        provider: "auto",
        profileId: "",
        model: "",
        label: "自动优选轻量模型",
        shortLabel: "自动轻量",
        description: "优先使用本机已登录的轻量模型（Hydrogen / Haiku / Mini）",
      },
    ];

    for (const prov of availableProviders) {
      const profiles = byProvider.get(prov) || [];
      const chosenProfile = profiles.find((p) => p.authenticated !== false) || profiles[0];
      const profileId = chosenProfile?.id || (prov === "antigravity" ? "cli" : "default");
      const rawModels = modelsByProvider.get(prov) || [];
      const preferredModelId = pickPreferredVoiceModel(prov, rawModels, "");
      const deduped = [];
      const seenIds = new Set();

      if (preferredModelId) {
        const hit = rawModels.find((m) => (m?.id || m?.model) === preferredModelId);
        seenIds.add(preferredModelId);
        deduped.push({
          id: preferredModelId,
          displayName: hit?.displayName || formatVoiceModelShortName(prov, preferredModelId),
          isLight: true,
          effort: /\b(low|fast|lite|mini|haiku|spark)\b/i.test(preferredModelId) ? "low" : "",
        });
      }
      const ranked = [...rawModels].sort((a, b) => voiceModelScoreForProvider(prov, b) - voiceModelScoreForProvider(prov, a));
      for (const m of ranked) {
        const id = String(m?.id || m?.model || "").trim();
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        deduped.push({
          id,
          displayName: m?.displayName || formatVoiceModelShortName(prov, id),
          isLight: voiceModelScoreForProvider(prov, m) >= 750,
          effort: String(m?.defaultReasoningEffort || ""),
        });
        if (deduped.length >= 6) break;
      }

      if (!deduped.length) {
        const fallbackId = pickPreferredVoiceModel(prov, [], "");
        if (fallbackId) {
          deduped.push({
            id: fallbackId,
            displayName: formatVoiceModelShortName(prov, fallbackId),
            isLight: true,
            effort: "low",
          });
        }
      }

      const provName = voiceProviderDisplayName(prov);
      for (const item of deduped) {
        const key = `${prov}:${profileId}:${item.id}`;
        const shortName = formatVoiceModelShortName(prov, item.id);
        options.push({
          key,
          provider: prov,
          profileId,
          model: item.id,
          effort: item.effort || "",
          isLight: Boolean(item.isLight),
          label: `${provName} · ${item.displayName}${item.isLight ? " (轻量)" : ""}`,
          shortLabel: prov === "antigravity" && /hydrogen/i.test(item.id)
            ? "Hydrogen"
            : `${provName} · ${shortName}`,
        });
      }
    }

    options.push({
      key: "local:local-rules",
      provider: "local",
      profileId: "",
      model: "local-rules",
      effort: "",
      isLight: true,
      label: "仅本机规则（零模型）",
      shortLabel: "本机规则",
      description: "无需 Gemini 或任何外部分析模型，纯本地状态总结与语音操控",
    });

    const resolved = await this.resolveVoiceTarget({
      voiceProvider,
      voiceModel,
      voiceProfileId,
      _installedProfiles: installedProfiles,
      _modelsByProvider: modelsByProvider,
    });

    return {
      options,
      resolved,
    };
  }

  async resolveVoiceTarget({
    callId = "",
    voiceProvider = "",
    voiceModel = "",
    voiceProfileId = "",
    _installedProfiles = null,
    _modelsByProvider = null,
  } = {}) {
    const callPref = callId ? this.#callStates.get(callId)?.voicePref : null;
    const rawProvider = String(
      voiceProvider
      || callPref?.voiceProvider
      || this.#env?.AGENT_CONTROL_VOICE_PROVIDER
      || "",
    ).trim().toLowerCase();
    const rawModel = String(
      voiceModel
      || callPref?.voiceModel
      || this.#env?.AGENT_CONTROL_VOICE_MODEL
      || "",
    ).trim();
    const rawProfileId = String(voiceProfileId || callPref?.voiceProfileId || "").trim();

    if (rawProvider === "local" || rawModel === "local-rules") {
      return {
        selectionKey: "local:local-rules",
        provider: "local",
        profileId: "",
        model: "local-rules",
        effort: "",
        shortLabel: "本机规则",
        displayName: "本机规则",
      };
    }

    const installedProfiles = _installedProfiles || await this.#getInstalledVoiceProfiles();
    const hasProviderList = installedProfiles.length > 0;

    const pickProfileFor = (prov) => {
      const candidates = installedProfiles.filter((p) => String(p?.provider || "").toLowerCase() === prov);
      if (rawProfileId) {
        const exact = candidates.find((p) => p.id === rawProfileId);
        if (exact) return exact;
      }
      return candidates.find((p) => p.authenticated !== false) || candidates[0] || null;
    };

    const getModelsFor = async (prov) => {
      if (_modelsByProvider?.has(prov)) return _modelsByProvider.get(prov);
      return this.#listModelsForProviderSafe(prov);
    };

    if (rawProvider && rawProvider !== "auto") {
      const prof = pickProfileFor(rawProvider);
      const models = await getModelsFor(rawProvider);
      const chosenModel = rawProvider === "antigravity"
        ? (rawModel || await this.resolveHydrogenModel().catch(() => DEFAULT_VOICE_HYDROGEN_MODEL))
        : pickPreferredVoiceModel(rawProvider, models, rawModel);
      const effort = /\b(low|fast|lite|mini|haiku|spark)\b|-low\b/i.test(chosenModel) ? "low" : "";
      const shortName = formatVoiceModelShortName(rawProvider, chosenModel);
      return {
        selectionKey: `${rawProvider}:${prof?.id || rawProfileId || "default"}:${chosenModel}`,
        provider: rawProvider,
        profileId: prof?.id || rawProfileId || (rawProvider === "antigravity" ? "cli" : "default"),
        model: chosenModel,
        effort,
        shortLabel: rawProvider === "antigravity" && /hydrogen/i.test(chosenModel) ? "Hydrogen" : `${voiceProviderDisplayName(rawProvider)} · ${shortName}`,
        displayName: `${voiceProviderDisplayName(rawProvider)} (${shortName})`,
      };
    }

    if (rawModel) {
      const inferredProvider = /claude|haiku|sonnet|opus/i.test(rawModel)
        ? "claude"
        : (/gpt|codex|o1|o3|o4|spark/i.test(rawModel) ? "codex" : (/grok/i.test(rawModel) ? "grok" : "antigravity"));
      const prof = pickProfileFor(inferredProvider);
      const effort = /\b(low|fast|lite|mini|haiku|spark)\b|-low\b/i.test(rawModel) ? "low" : "";
      const shortName = formatVoiceModelShortName(inferredProvider, rawModel);
      return {
        selectionKey: `${inferredProvider}:${prof?.id || "default"}:${rawModel}`,
        provider: inferredProvider,
        profileId: prof?.id || (inferredProvider === "antigravity" ? "cli" : "default"),
        model: rawModel,
        effort,
        shortLabel: inferredProvider === "antigravity" && /hydrogen/i.test(rawModel) ? "Hydrogen" : `${voiceProviderDisplayName(inferredProvider)} · ${shortName}`,
        displayName: `${voiceProviderDisplayName(inferredProvider)} (${shortName})`,
      };
    }

    // "auto": pick best available authenticated lightweight provider
    const hasExplicitOrMockAgy = basename(agyExecutable(this.#env) || "").includes("mock-agy");
    if (hasProviderList) {
      // First pass: prefer authenticated providers in priority order
      for (const prov of VOICE_LIGHT_PROVIDER_PRIORITY) {
        const candidates = installedProfiles.filter((p) => String(p?.provider || "").toLowerCase() === prov);
        const authed = candidates.find((p) => p.authenticated !== false);
        if (authed) {
          const models = await getModelsFor(prov);
          const chosenModel = prov === "antigravity"
            ? await this.resolveHydrogenModel().catch(() => DEFAULT_VOICE_HYDROGEN_MODEL)
            : pickPreferredVoiceModel(prov, models, "");
          const effort = /\b(low|fast|lite|mini|haiku|spark)\b|-low\b/i.test(chosenModel) ? "low" : "";
          const shortName = formatVoiceModelShortName(prov, chosenModel);
          return {
            selectionKey: "auto",
            provider: prov,
            profileId: authed.id || (prov === "antigravity" ? "cli" : "default"),
            model: chosenModel,
            effort,
            shortLabel: prov === "antigravity" && /hydrogen/i.test(chosenModel) ? "Hydrogen" : `${voiceProviderDisplayName(prov)} · ${shortName}`,
            displayName: `${voiceProviderDisplayName(prov)} (${shortName})`,
          };
        }
      }
      // Second pass: installed even if auth metadata unknown
      for (const prov of VOICE_LIGHT_PROVIDER_PRIORITY) {
        const first = installedProfiles.find((p) => String(p?.provider || "").toLowerCase() === prov);
        if (first) {
          const models = await getModelsFor(prov);
          const chosenModel = prov === "antigravity"
            ? await this.resolveHydrogenModel().catch(() => DEFAULT_VOICE_HYDROGEN_MODEL)
            : pickPreferredVoiceModel(prov, models, "");
          const effort = /\b(low|fast|lite|mini|haiku|spark)\b|-low\b/i.test(chosenModel) ? "low" : "";
          const shortName = formatVoiceModelShortName(prov, chosenModel);
          return {
            selectionKey: "auto",
            provider: prov,
            profileId: first.id || (prov === "antigravity" ? "cli" : "default"),
            model: chosenModel,
            effort,
            shortLabel: prov === "antigravity" && /hydrogen/i.test(chosenModel) ? "Hydrogen" : `${voiceProviderDisplayName(prov)} · ${shortName}`,
            displayName: `${voiceProviderDisplayName(prov)} (${shortName})`,
          };
        }
      }
    }

    if (hasExplicitOrMockAgy || typeof this.#hub?.listProvidersAndProfiles !== "function") {
      const model = await this.resolveHydrogenModel().catch(() => DEFAULT_VOICE_HYDROGEN_MODEL);
      return {
        selectionKey: "auto",
        provider: "antigravity",
        profileId: "cli",
        model,
        effort: /\b(low|fast|lite)\b|-low\b/i.test(model) ? "low" : "",
        shortLabel: "Hydrogen",
        displayName: "Antigravity (Hydrogen)",
      };
    }

    return {
      selectionKey: "local:local-rules",
      provider: "local",
      profileId: "",
      model: "local-rules",
      effort: "",
      shortLabel: "本机规则",
      displayName: "本机规则",
    };
  }

  async #resolveTaskModelAndEffort({
    provider = "",
    requestedModel = "",
    explicitFastHydrogen = false,
  } = {}) {
    const cleanModel = String(requestedModel || "").trim();
    if (provider && provider !== "antigravity") {
      return { model: cleanModel, effort: "" };
    }
    if (cleanModel && !explicitFastHydrogen && !/hydrogen/i.test(cleanModel)) {
      return { model: cleanModel, effort: "" };
    }
    const fastModel = await this.resolveHydrogenModel().catch(() => DEFAULT_VOICE_HYDROGEN_MODEL);
    const model = fastModel || DEFAULT_VOICE_HYDROGEN_MODEL;
    const effort = /\b(low|fast|lite)\b|-low\b/i.test(model) ? "low" : "";
    return { model, effort };
  }

  async #resolveAgyAppDataDir() {
    if (this.#clientAppDataDir) return this.#clientAppDataDir;
    const profiles = await discoverAntigravityProfiles({ env: this.#env }).catch(() => []);
    const usable = profiles.filter((p) => p.installed !== false && p.authenticated !== false);
    const chosen = usable.find((p) => p.id === "desktop")
      || usable[0]
      || profiles.find((p) => p.installed !== false && p.id === "desktop")
      || profiles.find((p) => p.installed !== false)
      || profiles[0];
    this.#clientAppDataDir = chosen?.home || "";
    return this.#clientAppDataDir;
  }

  async #ensureClient() {
    if (this.#closed) {
      throw Object.assign(new Error("语音通话服务已关闭"), { status: 503 });
    }
    if (this.#client?.isConnected) return this.#client;
    if (this.#initClientPromise) return this.#initClientPromise;

    this.#initClientPromise = (async () => {
      await mkdir(this.#utterancesDir, { recursive: true });
      const appDataDir = await this.#resolveAgyAppDataDir();
      const client = new AntigravityAcpClient({
        appDataDir,
        env: this.#env,
      });

      client.on("serverRequest", (msg) => {
        if (msg?.method !== "session/request_permission") return;
        const normalized = normalizeAcpPermissionRequest(msg);
        client.respond(
          normalized.rawId,
          createAcpPermissionResponse(normalized, { decision: "acceptForSession" }),
        );
      });

      client.on("sessionUpdate", (params) => {
        const sessionId = String(params?.sessionId || "");
        const update = params?.update || {};
        if (!sessionId) return;
        if (update.sessionUpdate === "agent_message_chunk") {
          const text = update.content?.text || "";
          const buf = this.#activeSessionTurn.get(sessionId);
          if (buf && text) buf.text += text;
          const sub = this.#activeSubagentSessions.get(sessionId);
          if (sub && text) sub.text += text;
          return;
        }
        const sub = this.#activeSubagentSessions.get(sessionId);
        if (sub && update.sessionUpdate === "tool_call") {
          const rawTitle = String(update.title || "").trim();
          const looksNoisy = /[\/\\]/.test(rawTitle) || /^(?:pending|running|in_progress|completed|failed|error|ok|done|success)$/i.test(rawTitle);
          const title = !looksNoisy ? stripSpeechNoise(rawTitle, 48) : "";
          const minGap = Math.max(this.#subagentMinFeedbackGapMs, 12_000);
          if (title && title !== sub.lastPhase && Date.now() - sub.lastProgressAt >= minGap) {
            sub.lastPhase = title;
            sub.lastProgressAt = Date.now();
            sub.step += 1;
            sub.emitProgress?.(`Hydrogen 子代理正在处理：${title}`);
          }
        }
      });

      client.on("exit", () => {
        if (this.#client === client) {
          this.#client = null;
          this.#calls.clear();
        }
      });

      await client.ensureReady();
      this.#client = client;
      return client;
    })().finally(() => {
      this.#initClientPromise = null;
    });

    return this.#initClientPromise;
  }

  #trimCallCache() {
    if (this.#calls.size > MAX_ACTIVE_CALL_SESSIONS) {
      const sorted = [...this.#calls.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
      while (sorted.length > MAX_ACTIVE_CALL_SESSIONS) {
        const [evictId] = sorted.shift();
        this.#calls.delete(evictId);
      }
    }
    if (this.#callStates.size > MAX_CALL_STATES) {
      const sortedStates = [...this.#callStates.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
      while (sortedStates.length > MAX_CALL_STATES) {
        const [evictId] = sortedStates.shift();
        this.#callStates.delete(evictId);
      }
    }
  }

  #ensureCallState(callId) {
    const cleanCallId = String(callId || "").trim() || "default-call";
    let state = this.#callStates.get(cleanCallId);
    if (!state) {
      state = {
        callId: cleanCallId,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        utterances: [],
        dispatchBatches: [],
        delegatedTasks: new Map(),
        observedLiveThreads: new Map(),
        completedResults: [],
        announcedMilestoneKeys: new Set(),
      };
      this.#callStates.set(cleanCallId, state);
      this.#trimCallCache();
    } else {
      state.lastUsedAt = Date.now();
    }
    return state;
  }

  registerUtterance({
    callId = "",
    utteranceId = "",
    text = "",
    source = "turn",
    intent = "",
    priority = "normal",
    provider = "none",
    replacesUtteranceIds = [],
  } = {}) {
    const cleanText = stripSpeechNoise(text, 360);
    const cleanCallId = String(callId || "").trim();
    const id = String(utteranceId || "").trim() || `utt-${randomUUID().slice(0, 10)}`;
    const now = Date.now();
    const expectedMs = estimateSpeechDurationMs(cleanText);
    const minMs = minAudibleDurationMs(cleanText);
    if (!cleanCallId || !cleanText) {
      return {
        utteranceId: id,
        callId: cleanCallId,
        text: cleanText,
        expectedMs,
        minAudibleMs: minMs,
      };
    }
    const callState = this.#ensureCallState(cleanCallId);
    const existing = callState.utterances.find((u) => u.utteranceId === id);
    const normalizedPriority = priority === "critical" ? "critical" : "normal";
    const replaces = Array.isArray(replacesUtteranceIds)
      ? replacesUtteranceIds.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    if (existing) {
      existing.text = cleanText;
      existing.source = String(source || existing.source || "turn");
      existing.intent = String(intent || existing.intent || "");
      existing.priority = normalizedPriority;
      existing.provider = String(provider || existing.provider || "none");
      existing.expectedMs = expectedMs;
      existing.minAudibleMs = minMs;
      existing.updatedAt = now;
      existing.attempts += 1;
      if (replaces.length) {
        existing.replacesUtteranceIds = [...new Set([...(existing.replacesUtteranceIds || []), ...replaces])];
      }
      return existing;
    }
    const record = {
      utteranceId: id,
      callId: cleanCallId,
      text: cleanText,
      source: String(source || "turn"),
      intent: String(intent || ""),
      priority: normalizedPriority,
      createdAt: now,
      updatedAt: now,
      deliveryStatus: "pending",
      heard: false,
      reason: "",
      provider: String(provider || "none"),
      playedMs: 0,
      expectedMs,
      minAudibleMs: minMs,
      attempts: 1,
      compensatedInTurn: false,
      replacesUtteranceIds: replaces,
    };
    callState.utterances.push(record);
    if (callState.utterances.length > MAX_UTTERANCES_PER_CALL) {
      callState.utterances = callState.utterances.slice(-MAX_UTTERANCES_PER_CALL);
    }
    return record;
  }

  getUnheardUtterances(callId = "", { nowMs = Date.now(), includeStalePending = false } = {}) {
    const cleanCallId = String(callId || "").trim();
    if (!cleanCallId) return [];
    const callState = this.#callStates.get(cleanCallId);
    if (!callState) return [];
    return callState.utterances.filter((rec) => {
      if (rec.heard || rec.compensatedInTurn) return false;
      if (nowMs - rec.createdAt > UNHEARD_TTL_MS) return false;
      if (rec.deliveryStatus === "unheard" || rec.deliveryStatus === "interrupted") {
        return true;
      }
      if (includeStalePending && rec.deliveryStatus === "pending" && nowMs - rec.createdAt >= STALE_PENDING_MS) {
        return true;
      }
      return false;
    });
  }

  recordPlaybackFeedback({
    callId = "",
    utteranceId = "",
    status = "",
    reason = "",
    provider = "",
    playedMs = 0,
    expectedMs = 0,
    spokenText = "",
    source = "notice",
    priority = "normal",
  } = {}) {
    let cleanCallId = String(callId || "").trim();
    const cleanId = String(utteranceId || "").trim();
    if (!cleanCallId && cleanId) {
      for (const cs of this.#callStates.values()) {
        if (cs.utterances.some((u) => u.utteranceId === cleanId)) {
          cleanCallId = cs.callId;
          break;
        }
      }
    }
    if (!cleanCallId) {
      throw Object.assign(new Error("缺少通话 ID"), { status: 400 });
    }
    const callState = this.#ensureCallState(cleanCallId);
    let rec = cleanId ? callState.utterances.find((u) => u.utteranceId === cleanId) : null;
    if (!rec) {
      if (cleanId || String(spokenText || "").trim()) {
        rec = this.registerUtterance({
          callId: cleanCallId,
          utteranceId: cleanId || undefined,
          text: spokenText || "语音提醒",
          source,
          priority,
          provider: provider || "browser",
        });
      } else {
        rec = callState.utterances[callState.utterances.length - 1] || null;
      }
    }
    if (!rec) {
      return {
        ok: true,
        callId: cleanCallId,
        utteranceId: cleanId,
        deliveryStatus: "unknown",
        heard: false,
        reason: "not_found",
        shouldRetryTts: false,
        unheardCount: 0,
        unheardItems: [],
      };
    }

    const rawStatus = String(status || "").trim().toLowerCase();
    const normalizedStatus = rawStatus === "failed" ? "unheard" : rawStatus;
    const cleanReason = String(reason || "").trim();
    const cleanPlayedMs = Math.max(0, Number(playedMs) || 0);
    const effExpectedMs = Math.max(rec.expectedMs || 0, Number(expectedMs) || 0, estimateSpeechDurationMs(rec.text));
    const minAudible = rec.minAudibleMs || minAudibleDurationMs(rec.text);

    rec.updatedAt = Date.now();
    if (provider) rec.provider = String(provider);
    if (cleanPlayedMs > 0) rec.playedMs = cleanPlayedMs;
    if (effExpectedMs > 0) rec.expectedMs = effExpectedMs;

    if (normalizedStatus === "played") {
      if (cleanReason === "muted_output") {
        rec.deliveryStatus = "unheard";
        rec.heard = false;
        rec.reason = "muted_output";
      } else if (cleanPlayedMs > 0 && cleanPlayedMs < minAudible) {
        rec.deliveryStatus = "unheard";
        rec.heard = false;
        rec.reason = "fake_short_end";
      } else {
        rec.deliveryStatus = "played";
        rec.heard = true;
        rec.reason = "";
        for (const oldId of rec.replacesUtteranceIds || []) {
          const oldRec = callState.utterances.find((u) => u.utteranceId === oldId);
          if (oldRec) {
            oldRec.heard = true;
            oldRec.compensatedInTurn = true;
            oldRec.updatedAt = rec.updatedAt;
          }
        }
      }
    } else if (normalizedStatus === "interrupted") {
      const ratio = effExpectedMs > 0 ? cleanPlayedMs / effExpectedMs : 0;
      rec.deliveryStatus = "interrupted";
      if (cleanReason === "user_barge_in" && ratio >= 0.45 && rec.priority !== "critical") {
        rec.heard = true;
        rec.reason = cleanReason;
      } else {
        rec.heard = false;
        rec.reason = cleanReason || "interrupted_early";
      }
    } else {
      rec.deliveryStatus = "unheard";
      rec.heard = false;
      rec.reason = cleanReason || "playback_failed";
    }

    const unheardItems = this.getUnheardUtterances(cleanCallId);
    return {
      ok: true,
      callId: cleanCallId,
      utteranceId: rec.utteranceId,
      deliveryStatus: rec.deliveryStatus,
      heard: rec.heard,
      reason: rec.reason,
      shouldRetryTts: !rec.heard && rec.deliveryStatus === "unheard" && rec.attempts < 2,
      unheardCount: unheardItems.length,
      unheardItems: unheardItems.map((u) => ({
        utteranceId: u.utteranceId,
        text: u.text,
        source: u.source,
        priority: u.priority,
        deliveryStatus: u.deliveryStatus,
        reason: u.reason,
        createdAt: u.createdAt,
      })),
    };
  }

  getCallDeliveryStatus({ callId = "" } = {}) {
    const cleanCallId = String(callId || "").trim();
    if (!cleanCallId) {
      return { ok: true, callId: "", unheardCount: 0, unheardItems: [], recentUtterances: [] };
    }
    const callState = this.#callStates.get(cleanCallId);
    const unheardItems = this.getUnheardUtterances(cleanCallId);
    const recentUtterances = (callState?.utterances || []).slice(-10).map((u) => ({
      utteranceId: u.utteranceId,
      text: u.text,
      source: u.source,
      intent: u.intent,
      priority: u.priority,
      deliveryStatus: u.deliveryStatus,
      heard: u.heard,
      reason: u.reason,
      provider: u.provider,
      playedMs: u.playedMs,
      expectedMs: u.expectedMs,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    }));
    return {
      ok: true,
      callId: cleanCallId,
      unheardCount: unheardItems.length,
      unheardItems: unheardItems.map((u) => ({
        utteranceId: u.utteranceId,
        text: u.text,
        source: u.source,
        priority: u.priority,
        deliveryStatus: u.deliveryStatus,
        reason: u.reason,
        createdAt: u.createdAt,
      })),
      recentUtterances,
      dispatchBatches: [...(callState?.dispatchBatches || [])],
      delegatedTasks: [...(callState?.delegatedTasks?.values() || [])],
      completedResults: [...(callState?.completedResults || [])],
    };
  }

  async startCall({
    callId = "",
    voiceProvider = "",
    voiceModel = "",
    voiceProfileId = "",
  } = {}) {
    const cleanCallId = String(callId || "").trim() || `call-${randomUUID().slice(0, 8)}`;
    const callState = this.#ensureCallState(cleanCallId);
    if (voiceProvider || voiceModel || voiceProfileId) {
      callState.voicePref = {
        voiceProvider: String(voiceProvider || "").trim(),
        voiceModel: String(voiceModel || "").trim(),
        voiceProfileId: String(voiceProfileId || "").trim(),
      };
    } else if (!callState.voicePref) {
      callState.voicePref = { voiceProvider: "", voiceModel: "", voiceProfileId: "" };
    }
    const activePref = callState.voicePref;
    const hasExplicitAsrBin = Boolean(String(this.#env?.VOICE_ASR_BIN || "").trim());
    const agyBinName = basename(agyExecutable(this.#env) || "");
    const isMockAgy = agyBinName.includes("mock-agy");
    let model = "";
    let dispatchModel = DEFAULT_VOICE_HYDROGEN_MODEL;
    let dispatchProvider = "antigravity";
    let dispatchProfileId = "";
    let dispatchLabel = "Hydrogen";
    let modelOptions = [];
    let selectedVoiceOption = activePref.voiceProvider === "local"
      ? "local:local-rules"
      : (activePref.voiceProvider && activePref.voiceProvider !== "auto" && activePref.voiceModel
          ? `${activePref.voiceProvider}:${activePref.voiceProfileId || "default"}:${activePref.voiceModel}`
          : "auto");
    let asrAvailable = true;
    let asrEngine = hasExplicitAsrBin ? "mock-whisper" : "mlx-whisper";
    let warmed = false;
    let warning = "";

    const catalogPromise = Promise.race([
      this.listVoiceModelOptions(activePref).catch(() => null),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 2500)),
    ]);

    if (!isMockAgy || hasExplicitAsrBin) {
      const canWhisper = this.#hasLocalWhisperRuntime();
      if (!canWhisper) {
        model = "browser-speech";
        asrAvailable = false;
        asrEngine = "browser";
        warmed = true;
        const catalog = await catalogPromise;
        if (catalog?.resolved) {
          dispatchProvider = catalog.resolved.provider;
          dispatchProfileId = catalog.resolved.profileId;
          dispatchModel = catalog.resolved.model;
          dispatchLabel = catalog.resolved.shortLabel;
          selectedVoiceOption = catalog.resolved.selectionKey || selectedVoiceOption;
        }
        modelOptions = catalog?.options || [];
      } else {
        model = hasExplicitAsrBin ? "mock-whisper" : "mlx-whisper";
        const asrWarmPromise = this.#ensureAsrWorker();
        asrWarmPromise.catch(() => {});
        let asrWarmResult = "ok";
        try {
          const [warmOutcome, catalog] = await Promise.all([
            Promise.race([
              asrWarmPromise.then(() => "ok"),
              new Promise((resolveWarm) => setTimeout(() => resolveWarm("timeout"), 3_500)),
            ]),
            catalogPromise,
          ]);
          asrWarmResult = warmOutcome;
          if (catalog?.resolved) {
            dispatchProvider = catalog.resolved.provider;
            dispatchProfileId = catalog.resolved.profileId;
            dispatchModel = catalog.resolved.model;
            dispatchLabel = catalog.resolved.shortLabel;
            selectedVoiceOption = catalog.resolved.selectionKey || selectedVoiceOption;
          }
          modelOptions = catalog?.options || [];
          warmed = asrWarmResult === "ok";
          if (asrWarmResult === "timeout") {
            warning = "本地语音识别正在加载，稍候片刻即可使用";
          }
        } catch (error) {
          asrAvailable = false;
          asrEngine = "browser";
          model = "browser-speech";
          warning = error?.message || "本地 Whisper 暂不可用，已切换浏览器/文本识别模式";
          const catalog = await catalogPromise;
          if (catalog?.resolved) {
            dispatchProvider = catalog.resolved.provider;
            dispatchProfileId = catalog.resolved.profileId;
            dispatchModel = catalog.resolved.model;
            dispatchLabel = catalog.resolved.shortLabel;
            selectedVoiceOption = catalog.resolved.selectionKey || selectedVoiceOption;
          }
          modelOptions = catalog?.options || [];
        }
      }
    } else {
      const catalog = await catalogPromise;
      if (catalog?.resolved) {
        dispatchProvider = catalog.resolved.provider;
        dispatchProfileId = catalog.resolved.profileId;
        dispatchModel = catalog.resolved.model;
        dispatchLabel = catalog.resolved.shortLabel;
        selectedVoiceOption = catalog.resolved.selectionKey || selectedVoiceOption;
      } else {
        dispatchModel = await this.resolveHydrogenModel();
      }
      modelOptions = catalog?.options || [];
      model = dispatchModel;
      asrEngine = "multimodal-acp";
      if (dispatchProvider === "antigravity") {
        try {
          const client = await this.#ensureClient();
          let entry = this.#calls.get(cleanCallId);
          if (!entry) {
            const created = await client.newSession({ cwd: this.#workspaceDir });
            const sessionId = String(created?.sessionId || "");
            if (!sessionId) throw new Error("Antigravity 未返回语音通话会话 ID");
            await client.configureSession(sessionId, {
              model: dispatchModel,
              effort: "low",
              permissionMode: "turbo",
            });
            entry = {
              callId: cleanCallId,
              sessionId,
              model: dispatchModel,
              createdAt: Date.now(),
              lastUsedAt: Date.now(),
            };
            this.#calls.set(cleanCallId, entry);
            this.#trimCallCache();
          } else {
            entry.lastUsedAt = Date.now();
          }
          warmed = true;
        } catch (error) {
          warning = error?.message || "Hydrogen 预热暂不可用";
        }
      } else {
        warmed = true;
      }
    }

    const ttsBin = resolveEdgeTtsExecutable(this.#env);
    const sayBin = resolveMacSayExecutable(this.#env);
    callState.resolvedTarget = {
      provider: dispatchProvider,
      profileId: dispatchProfileId,
      model: dispatchModel,
      shortLabel: dispatchLabel,
    };
    return {
      ok: true,
      callId: cleanCallId,
      model,
      dispatchProvider,
      dispatchProfileId,
      dispatchModel,
      dispatchLabel,
      selectedVoiceOption,
      modelOptions,
      asrAvailable,
      asrEngine,
      warmed,
      ttsEngine: ttsBin ? "edge-tts" : (sayBin ? "macos-say" : "browser"),
      ...(warning ? { warning } : {}),
    };
  }

  endCall({ callId = "" } = {}) {
    const cleanCallId = String(callId || "").trim();
    if (cleanCallId) {
      this.#calls.delete(cleanCallId);
      this.#callStates.delete(cleanCallId);
    }
    return { ok: true, callId: cleanCallId };
  }

  async buildLiveSnapshot({ activeThreadId = "", callId = "" } = {}) {
    const [threadsPayload, providersPayload] = await Promise.all([
      this.#hub.listThreads({ archived: "0", limit: 80 }),
      this.#hub.listProvidersAndProfiles(),
    ]);
    const threads = threadsPayload?.threads || [];
    const threadById = new Map(threads.map((t) => [t.id, t]));
    const projectsMeta = threadsPayload?.projectsMeta || {};
    const cleanCallId = String(callId || "").trim();
    const callState = cleanCallId ? this.#callStates.get(cleanCallId) : null;
    const pendingRequests = await Promise.resolve(this.#hub.allPendingRequests?.() || []);
    const pendingByThread = new Map();
    for (const req of pendingRequests) {
      if (!req.threadId) continue;
      pendingByThread.set(req.threadId, (pendingByThread.get(req.threadId) || 0) + 1);
    }

    const byCwd = new Map();
    for (const t of threads) {
      const cwd = String(t.cwd || "").trim() || os.homedir();
      let group = byCwd.get(cwd);
      if (!group) {
        const meta = projectsMeta[cwd] || {};
        group = {
          cwd,
          name: meta.alias || basename(cwd) || cwd,
          alias: meta.alias || "",
          pinned: Boolean(meta.pinned),
          liveCount: 0,
          pendingCount: 0,
          updatedAt: Number(t.updatedAt) || 0,
          threads: [],
        };
        byCwd.set(cwd, group);
      }
      const reqCount = pendingByThread.get(t.id) || 0;
      if (t.live) group.liveCount += 1;
      group.pendingCount += reqCount;
      if ((t.updatedAt || 0) > group.updatedAt) group.updatedAt = t.updatedAt || 0;
      if (group.threads.length < 4) {
        group.threads.push({
          id: t.id,
          title: String(t.title || t.name || "新会话").slice(0, 64),
          provider: t.provider,
          model: String(t.model || ""),
          live: Boolean(t.live),
          pendingCount: reqCount,
          goalActive: Boolean(t.goalState?.active),
          preview: cleanPreviewText(t.preview || "", 80),
        });
      }
    }

    for (const [cwd, meta] of Object.entries(projectsMeta)) {
      if (!meta?.pinned || byCwd.has(cwd)) continue;
      byCwd.set(cwd, {
        cwd,
        name: meta.alias || basename(cwd) || cwd,
        alias: meta.alias || "",
        pinned: true,
        liveCount: 0,
        pendingCount: 0,
        updatedAt: 0,
        threads: [],
      });
    }

    const projects = [...byCwd.values()]
      .sort((a, b) => {
        if (b.pendingCount !== a.pendingCount) return b.pendingCount - a.pendingCount;
        if (b.liveCount !== a.liveCount) return b.liveCount - a.liveCount;
        if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? -1 : 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      })
      .slice(0, 14);

    let activeThreadReply = "";
    if (activeThreadId) {
      const readRes = await this.#hub.readThread(activeThreadId, { limit: 4 }).catch(() => null);
      activeThreadReply = pickLatestAssistantSnippet(readRes);
    }

    return {
      activeThreadId: activeThreadId || "",
      activeThreadReply,
      availableProfiles: (providersPayload?.profiles || [])
        .filter((p) => p.installed && !p.health?.disabled && p.health?.status !== "unavailable")
        .map((p) => ({
          provider: p.provider,
          profileId: p.id,
          label: p.label,
          authenticated: p.authenticated !== false,
        })),
      pendingRequests: pendingRequests.slice(0, 8).map((r) => {
        const thread = threadById.get(r.threadId);
        const cwd = String(r.cwd || thread?.cwd || "").trim();
        const group = cwd ? byCwd.get(cwd) : null;
        return {
          requestId: r.id,
          threadId: r.threadId,
          provider: r.provider,
          projectCwd: cwd,
          projectName: group?.alias || group?.name || (cwd ? basename(cwd) : ""),
          title: String(r.title || "").slice(0, 80),
          question: String(r.question || "").slice(0, 80),
          command: String(r.command || "").slice(0, 80),
        };
      }),
      projects,
      completedResults: [...(callState?.completedResults || [])],
      delegatedTasks: [...(callState?.delegatedTasks?.values() || [])],
    };
  }

  async synthesizeSpeech(input = {}, maybeOpts = {}) {
    const opts = typeof input === "string" ? { ...(maybeOpts || {}), text: input } : (input || {});
    const {
      text = "",
      voice = DEFAULT_VOICE_TTS_NAME,
      callId = "",
      utteranceId = "",
      source = "notice",
      priority = "normal",
      preferOffline = false,
      register = true,
    } = opts;
    const cleanText = stripSpeechNoise(text, 360);
    const cleanCallId = String(callId || "").trim();
    const cleanUttId = String(utteranceId || "").trim();
    if (!cleanText) {
      return {
        audioBase64: "",
        mimeType: "",
        provider: "none",
        text: "",
        utteranceId: cleanUttId,
        expectedMs: 0,
      };
    }

    let audioBase64 = "";
    let mimeType = "";
    let provider = "browser";
    const ttsBin = resolveEdgeTtsExecutable(this.#env);
    const sayBin = resolveMacSayExecutable(this.#env);
    const cacheKey = cleanText.length <= 120
      ? `${String(voice || DEFAULT_VOICE_TTS_NAME)}|${ttsBin}|${sayBin}|${preferOffline ? "off" : "auto"}|${cleanText}`
      : "";
    const cached = cacheKey ? this.#ttsCache.get(cacheKey) : null;
    if (cached) {
      audioBase64 = cached.audioBase64;
      mimeType = cached.mimeType;
      provider = cached.provider;
    }

    if (!audioBase64 && !preferOffline && ttsBin) {
      await mkdir(this.#utterancesDir, { recursive: true });
      const outPath = resolve(this.#utterancesDir, `tts-${randomUUID()}.mp3`);
      try {
        await this.#execFile(
          ttsBin,
          [
            "--voice",
            String(voice || DEFAULT_VOICE_TTS_NAME),
            "--rate=+8%",
            "--text",
            cleanText,
            "--write-media",
            outPath,
          ],
          {
            env: this.#env,
            cwd: this.#workspaceDir,
            shell: false,
            timeout: EDGE_TTS_TIMEOUT_MS,
            maxBuffer: 128 * 1024,
          },
        );
        const mp3Buf = await readFile(outPath);
        if (mp3Buf.length > 0) {
          audioBase64 = mp3Buf.toString("base64");
          mimeType = "audio/mpeg";
          provider = "edge-tts";
        }
      } catch {
        // Fall through to offline macOS say or browser synthesis.
      } finally {
        await unlink(outPath).catch(() => {});
      }
    }

    if (!audioBase64) {
      const sayBin = resolveMacSayExecutable(this.#env);
      if (sayBin) {
        await mkdir(this.#utterancesDir, { recursive: true });
        const outWavPath = resolve(this.#utterancesDir, `say-${randomUUID()}.wav`);
        const preferredVoice = String(this.#env?.MACOS_SAY_VOICE || "Tingting").trim();
        try {
          const runSay = async (voiceArgs = []) => {
            await this.#execFile(
              sayBin,
              [
                ...voiceArgs,
                "--file-format=WAVE",
                "--data-format=LEI16@22050",
                "-o",
                outWavPath,
                cleanText,
              ],
              {
                env: this.#env,
                cwd: this.#workspaceDir,
                shell: false,
                timeout: EDGE_TTS_TIMEOUT_MS,
                maxBuffer: 128 * 1024,
              },
            );
          };
          try {
            if (preferredVoice) {
              await runSay(["-v", preferredVoice]);
            } else {
              await runSay([]);
            }
          } catch {
            if (preferredVoice) {
              await runSay([]);
            }
          }
          const wavBuf = await readFile(outWavPath).catch(() => Buffer.alloc(0));
          if (wavBuf.length > 0) {
            audioBase64 = wavBuf.toString("base64");
            mimeType = "audio/wav";
            provider = "macos-say";
          }
        } catch {
          // Fall through to browser speechSynthesis.
        } finally {
          await unlink(outWavPath).catch(() => {});
        }
      }
    }

    if (cacheKey && audioBase64) {
      this.#ttsCache.set(cacheKey, { audioBase64, mimeType, provider });
      if (this.#ttsCache.size > 36) {
        const oldestKey = this.#ttsCache.keys().next().value;
        if (oldestKey) this.#ttsCache.delete(oldestKey);
      }
    }

    let finalUttId = cleanUttId;
    let expectedMs = estimateSpeechDurationMs(cleanText);
    if (register && (cleanCallId || cleanUttId)) {
      if (cleanCallId) {
        const callState = this.#callStates.get(cleanCallId);
        const existing = cleanUttId ? callState?.utterances.find((u) => u.utteranceId === cleanUttId) : null;
        if (existing) {
          existing.provider = provider;
          existing.updatedAt = Date.now();
          if (preferOffline || existing.deliveryStatus === "unheard") {
            existing.attempts += 1;
          }
          finalUttId = existing.utteranceId;
          expectedMs = existing.expectedMs;
        } else {
          const rec = this.registerUtterance({
            callId: cleanCallId,
            utteranceId: cleanUttId,
            text: cleanText,
            source,
            priority,
            provider,
          });
          finalUttId = rec.utteranceId;
          expectedMs = rec.expectedMs;
        }
      } else {
        finalUttId = cleanUttId || `utt-${randomUUID().slice(0, 10)}`;
      }
    }

    return {
      audioBase64,
      mimeType,
      provider,
      text: cleanText,
      utteranceId: finalUttId,
      expectedMs,
    };
  }

  #buildHydrogenPrompt({
    snapshot,
    audioFilePath = "",
    transcriptText = "",
    mode = "turn",
    unheardUtterances = [],
  }) {
    const rules = [
      `${VOICE_CALL_TAG} 你是运行在用户本机 Agent Control 里的实时语音通话副驾（多模态 Hydrogen）。`,
      "用户在手机上通过语音电话与你连续对话，经常一边忙或开车一边听进度、找项目或口头给某个智能体下达任务。",
      "严格规则：",
      audioFilePath
        ? `1. 请调用一次 read_file 工具读取本轮用户原声音频文件（${audioFilePath}），直接听懂原话并识别可能的中英文混读或同音字；严禁修改任何代码文件、严禁执行命令或搜索仓库。`
        : "1. 本轮无音频附件，请直接依据用户的文本请求或播报模式处理；严禁调用读写文件或命令工具。",
      "2. 只能从下方实时控制快照 JSON 中挑选真实存在的 `cwd`、`threads[].id`、`pendingRequests[].requestId`，绝不编造。",
      "3. 先判断指令复杂度与归属：（a）简单查询/打开项目/审批/重播/唤醒由你自己直接完成，`executionTier` 设为 `self_simple`；（b）你自己可做但需要较长耗时分析/排查/梳理/总结上下文/对比方案的任务，`intent` 设为 `subagent_hydrogen`、`executionTier` 设为 `subagent_hydrogen`；（c）需要交由其他项目或会话执行的任务，`intent` 设为 `send_turn`（或 `create_thread`）、`executionTier` 设为 `external_thread`（若用户要求直接出结果、给结论、停止等待、别等了、立即发送或别排队，`dispatchMode` 设为 `immediate`，否则设为 `queue`）；若仅停止任务设 `interrupt_thread`；若用户没听清要求再说一遍，设 `intent` 为 `repeat_last`。",
      "4. `spokenReply` 用 1~3 句自然简洁的电话口语回复（像电话里的得力副驾），绝不念出文件路径、斜杠、代码块、长 ID 或 Markdown 符号；若 `executionTier` 为 `external_thread`，告知已交付给对应会话处理即可，不要念出未完成或冗余长文。",
      "5. 最终回复必须且只能输出一个合法 JSON 对象，格式如下：",
      '{"heardText":"听到的用户原话","intent":"summarize_progress|open_thread|open_project|subagent_hydrogen|send_turn|create_thread|approve_request|interrupt_thread|repeat_last","executionTier":"self_simple|subagent_hydrogen|external_thread","targetProjectCwd":"","targetThreadId":"","provider":"","dispatchMode":"immediate|queue","instruction":"","requestId":"","decision":"accept|decline|","spokenReply":"用于电话朗读的简短自然中文回复"}',
      "",
      "<LIVE_CONTROL_SNAPSHOT>",
      JSON.stringify(snapshot),
      "</LIVE_CONTROL_SNAPSHOT>",
    ];

    if (Array.isArray(unheardUtterances) && unheardUtterances.length > 0) {
      rules.push("<UNHEARD_PREVIOUS_REPLIES>");
      rules.push(JSON.stringify(unheardUtterances.map((u) => ({
        utteranceId: u.utteranceId,
        text: u.text,
        reason: u.reason,
      }))));
      rules.push("</UNHEARD_PREVIOUS_REPLIES>");
    }

    if (mode === "briefing") {
      rules.push("用户点击了【播报最新进度】：请用 2~3 句电话口语总结当前最需要关注的待确认请求、运行中任务与最新进展，heardText 填 \"播报当前任务进度\"，intent 填 \"summarize_progress\"。");
    } else if (transcriptText) {
      rules.push(`用户补充输入：${transcriptText}`);
    } else if (audioFilePath) {
      rules.push(`请立即 read_file("${audioFilePath}") 听取用户说话内容并返回唯一 JSON。`);
    }
    return rules.join("\n");
  }

  #emitEvent(eventName, payload) {
    if (typeof this.#onEvent === "function") {
      try {
        this.#onEvent(eventName, payload);
      } catch {}
    }
  }

  #upsertDispatchBatch(callId, batchRecord) {
    if (!callId || !batchRecord?.batchId) return;
    const callState = this.#ensureCallState(callId);
    if (!Array.isArray(callState.dispatchBatches)) {
      callState.dispatchBatches = [];
    }
    const idx = callState.dispatchBatches.findIndex((b) => b.batchId === batchRecord.batchId);
    if (idx >= 0) {
      callState.dispatchBatches[idx] = { ...callState.dispatchBatches[idx], ...batchRecord };
    } else {
      callState.dispatchBatches.push(batchRecord);
      if (callState.dispatchBatches.length > 20) {
        callState.dispatchBatches = callState.dispatchBatches.slice(-20);
      }
    }
  }

  #prepareDispatchAction(plan, snapshot, { activeThreadId = "", callId = "" } = {}) {
    const intent = plan.intent || "summarize_progress";
    if (intent === "no_speech" || plan?.noSpeech) {
      return {
        needsBackground: false,
        immediateResult: {
          ok: true,
          action: "no_speech",
          executionTier: "self_simple",
          noSpeech: true,
          summaryTag: "",
        },
      };
    }
    if (intent === "repeat_last") {
      return {
        needsBackground: false,
        immediateResult: {
          ok: true,
          action: "repeat_last",
          executionTier: "self_simple",
          summaryTag: "已重播语音",
        },
      };
    }
    const fuzzy = resolveFuzzyVoiceTarget(plan, snapshot);
    const resolvedProject = fuzzy.project;
    const resolvedThreadId = fuzzy.threadId
      || activeThreadId
      || snapshot.activeThreadId
      || "";
    const resolvedCwd = fuzzy.cwd || "";
    const targetName = resolvedProject?.name || (resolvedCwd ? basename(resolvedCwd) : "当前对话");

    if (intent === "subagent_hydrogen") {
      const taskText = plan.instruction || plan.heardText || "";
      const callState = callId ? this.#callStates.get(callId) : null;
      const voicePref = callState?.voicePref || {};
      const resolvedProv = callState?.resolvedTarget?.provider || "";
      const fallbackProv = VOICE_LIGHT_PROVIDER_PRIORITY.find((p) =>
        (snapshot?.availableProfiles || []).some((prof) => prof.provider === p && prof.authenticated !== false),
      ) || "";
      const prefProv = String(plan.provider || voicePref.voiceProvider || resolvedProv || fallbackProv || "").trim().toLowerCase();
      const useHydrogenNaming = !prefProv || prefProv === "auto" || prefProv === "antigravity";
      const subagentLabel = prefProv === "local"
        ? "本机规则"
        : (useHydrogenNaming ? "Hydrogen 子代理" : `${voiceProviderDisplayName(prefProv)} 轻量助手`);
      return {
        needsBackground: true,
        alwaysAsync: true,
        pendingMeta: {
          action: "subagent_hydrogen",
          executionTier: "subagent_hydrogen",
          provider: prefProv || (useHydrogenNaming ? "antigravity" : ""),
          focusThreadId: resolvedThreadId || "",
          focusProjectCwd: resolvedCwd || "",
          projectName: targetName,
          summaryTag: `${subagentLabel}处理中`,
          ackReply: useHydrogenNaming
            ? "好的，这个需要一点时间处理，我先开一个 Hydrogen 子代理帮你做，过程中会持续同步进展，有结果马上反馈给你。"
            : `好的，我先用${subagentLabel}帮你分析整理，有结果马上反馈给你。`,
        },
        execute: async ({ batchId = "", utteranceId = "", emitProgress = () => {} } = {}) => {
          const res = await this.#runHydrogenSubagent({
            callId,
            batchId,
            utteranceId,
            instruction: taskText,
            snapshot,
            activeThreadId: resolvedThreadId || activeThreadId || snapshot.activeThreadId || "",
            projectCwd: resolvedCwd,
            preferredProvider: plan.provider || voicePref.voiceProvider || "",
            preferredModel: plan.model || voicePref.voiceModel || "",
            preferredProfileId: voicePref.voiceProfileId || "",
            emitProgress,
          });
          const resProvider = String(res.provider || "antigravity").toLowerCase();
          const resLabel = resProvider === "antigravity"
            ? "Hydrogen 子代理"
            : (resProvider === "local" ? "本机规则" : `${voiceProviderDisplayName(resProvider)} 子代理`);
          const spokenSummary = stripSpeechNoise(res.summary || "已完成分析。", 220);
          if (callId && spokenSummary) {
            this.#recordCompletedResult(callId, {
              threadId: `subagent:${batchId || randomUUID().slice(0, 8)}`,
              projectCwd: resolvedCwd,
              projectName: resLabel,
              title: stripSpeechNoise(taskText, 40) || "子代理分析",
              status: "completed",
              lastResultSummary: spokenSummary,
              source: "subagent_hydrogen",
            });
          }
          return {
            ok: true,
            action: "subagent_hydrogen",
            executionTier: "subagent_hydrogen",
            focusThreadId: resolvedThreadId || "",
            focusProjectCwd: resolvedCwd,
            provider: resProvider,
            model: res.model || DEFAULT_VOICE_HYDROGEN_MODEL,
            summaryTag: `${resLabel}已完成`,
            spokenFeedback: `${resLabel}有结果了：${spokenSummary}`,
            shouldSpeak: true,
            priority: "normal",
          };
        },
      };
    }

    if (intent === "open_thread" && resolvedThreadId) {
      return {
        needsBackground: false,
        immediateResult: {
          ok: true,
          action: "open_thread",
          focusThreadId: resolvedThreadId,
          focusProjectCwd: resolvedCwd,
          summaryTag: "已定位到对话",
        },
      };
    }

    if (intent === "open_project" && (resolvedCwd || resolvedThreadId)) {
      const topThreadId = fuzzy.thread?.id || resolvedProject?.threads?.[0]?.id || "";
      return {
        needsBackground: false,
        immediateResult: {
          ok: true,
          action: resolvedCwd ? "open_project" : "open_thread",
          focusThreadId: topThreadId || resolvedThreadId,
          focusProjectCwd: resolvedCwd,
          summaryTag: `已切到 ${resolvedProject?.name || basename(resolvedCwd || "项目")}`,
        },
      };
    }

    if (intent === "approve_request") {
      const targetReq = snapshot.pendingRequests.find((r) => r.requestId === plan.requestId)
        || snapshot.pendingRequests[0];
      if (!targetReq) {
        return {
          needsBackground: false,
          immediateResult: {
            ok: false,
            action: "approve_request",
            summaryTag: "暂无待确认请求",
            overrideReply: "当前没有等待确认的审批请求。",
          },
        };
      }
      const decision = plan.decision === "decline" ? "decline" : "accept";
      const focusThreadId = targetReq.threadId || resolvedThreadId;
      const focusProjectCwd = targetReq.projectCwd || resolvedCwd;
      return {
        needsBackground: true,
        pendingMeta: {
          action: "approve_request",
          decision,
          focusThreadId,
          focusProjectCwd,
          projectName: targetReq.projectName || targetName,
          summaryTag: decision === "decline" ? "正在拒绝审批" : "正在批准继续",
          ackReply: decision === "decline" ? "好的，正在拒绝这条待确认请求。" : "好的，正在批准继续执行。",
        },
        execute: async () => {
          await this.#hub.respondToRequest(targetReq.requestId, { decision });
          return {
            ok: true,
            action: "approve_request",
            decision,
            focusThreadId,
            focusProjectCwd,
            summaryTag: decision === "decline" ? "已拒绝审批请求" : "已批准继续执行",
            spokenFeedback: decision === "decline" ? "已拒绝该审批请求。" : "已批准，任务将继续运行。",
            shouldSpeak: false,
          };
        },
      };
    }

    if (intent === "interrupt_thread" && resolvedThreadId) {
      return {
        needsBackground: true,
        pendingMeta: {
          action: "interrupt_thread",
          focusThreadId: resolvedThreadId,
          focusProjectCwd: resolvedCwd,
          projectName: targetName,
          summaryTag: "正在中断任务",
          ackReply: "好的，正在停止当前任务。",
        },
        execute: async () => {
          await this.#hub.interrupt({ threadId: resolvedThreadId });
          return {
            ok: true,
            action: "interrupt_thread",
            focusThreadId: resolvedThreadId,
            focusProjectCwd: resolvedCwd,
            summaryTag: "已中断任务",
            spokenFeedback: "任务已停止。",
            shouldSpeak: false,
          };
        },
      };
    }

    if (intent === "interrupt_thread") {
      return {
        needsBackground: false,
        immediateResult: {
          ok: false,
          action: "interrupt_thread",
          summaryTag: "暂无运行任务",
          overrideReply: "目前没有正在运行的任务。",
        },
      };
    }

    if (intent === "send_turn") {
      const text = plan.instruction || plan.heardText;
      if (!text) {
        return {
          needsBackground: false,
          immediateResult: { ok: false, action: "send_turn", summaryTag: "指令为空" },
        };
      }
      if (!resolvedThreadId && resolvedCwd) {
        return {
          needsBackground: true,
          pendingMeta: {
            action: "create_thread",
            executionTier: "external_thread",
            focusThreadId: "",
            focusProjectCwd: resolvedCwd,
            projectName: targetName,
            summaryTag: `正在为 ${targetName} 新建并派发`,
            ackReply: `好的，正在为 ${targetName} 新建任务并派发。`,
          },
          execute: async ({ batchId = "" } = {}) => {
            const created = await this.#startBestThread({
              provider: plan.provider,
              model: plan.model,
              explicitFastHydrogen: Boolean(plan.explicitFastHydrogen),
              cwd: resolvedCwd,
              text,
              snapshot,
            });
            const createdId = created?.thread?.id || "";
            if (callId && createdId) {
              this.#registerDelegatedTask(callId, {
                threadId: createdId,
                projectCwd: resolvedCwd,
                projectName: targetName,
                title: created?.thread?.title || targetName,
                instruction: text,
                batchId,
                queued: false,
              });
            }
            return {
              ok: true,
              action: "create_thread",
              executionTier: "external_thread",
              focusThreadId: createdId,
              focusProjectCwd: resolvedCwd,
              model: created?.thread?.model || "",
              summaryTag: "已新开任务并派发",
              spokenFeedback: `${targetName} 新任务已启动，正在运行。`,
              shouldSpeak: false,
            };
          },
        };
      }
      if (!resolvedThreadId) {
        return {
          needsBackground: false,
          immediateResult: { ok: false, action: "send_turn", summaryTag: "未找到目标对话" },
        };
      }
      const targetProvider = fuzzy.thread?.provider
        || (resolvedThreadId.includes(":") ? resolvedThreadId.split(":")[0] : "");
      const existingThreadModel = String(fuzzy.thread?.model || "").trim();
      const shouldOverrideTurnModel = targetProvider === "antigravity"
        && (Boolean(plan.explicitFastHydrogen) || Boolean(plan.model) || !existingThreadModel);
      const explicitPlanMode = plan.dispatchMode === "immediate" || plan.dispatchMode === "queue" ? plan.dispatchMode : "";
      const detectedMode = detectVoiceDispatchMode(text);
      const dispatchMode = explicitPlanMode || detectedMode.dispatchMode;
      const isImmediate = dispatchMode === "immediate";
      return {
        needsBackground: true,
        pendingMeta: {
          action: "send_turn",
          executionTier: "external_thread",
          dispatchMode,
          immediate: isImmediate,
          focusThreadId: resolvedThreadId,
          focusProjectCwd: resolvedCwd,
          projectName: targetName,
          summaryTag: isImmediate ? `正在立即发送给 ${targetName}` : `正在派发给 ${targetName}`,
          ackReply: isImmediate
            ? `好的，正在立即发送给 ${targetName}，不排队。`
            : `好的，正在转达给 ${targetName} 处理。`,
        },
        execute: async ({ batchId = "" } = {}) => {
          let turnModelOpts = {};
          if (shouldOverrideTurnModel) {
            const resolvedTurn = await this.#resolveTaskModelAndEffort({
              provider: targetProvider,
              requestedModel: plan.model,
              explicitFastHydrogen: Boolean(plan.explicitFastHydrogen),
            });
            if (resolvedTurn.model) {
              turnModelOpts = {
                model: resolvedTurn.model,
                ...(resolvedTurn.effort ? { effort: resolvedTurn.effort } : {}),
              };
            }
          }
          if (isImmediate) {
            try {
              const sendRes = await this.#hub.sendTurn({
                threadId: resolvedThreadId,
                text,
                permissionMode: "turbo",
                writerConflictPolicy: "reject",
                steer: true,
                ...turnModelOpts,
              });
              if (callId && resolvedThreadId) {
                this.#registerDelegatedTask(callId, {
                  threadId: resolvedThreadId,
                  projectCwd: resolvedCwd,
                  projectName: targetName,
                  title: fuzzy.thread?.title || targetName,
                  instruction: text,
                  batchId,
                  queued: false,
                });
              }
              return {
                ok: true,
                action: "send_turn",
                executionTier: "external_thread",
                dispatchMode: "immediate",
                immediate: true,
                steered: Boolean(sendRes?.steered),
                queued: false,
                focusThreadId: resolvedThreadId,
                focusProjectCwd: resolvedCwd,
                model: turnModelOpts.model || existingThreadModel,
                summaryTag: sendRes?.steered ? `已即时插入引导 (${targetName})` : `已立即发送给 ${targetName}`,
                spokenFeedback: "",
                shouldSpeak: false,
              };
            } catch (error) {
              if (Number(error?.status) === 409 && typeof this.#hub.interrupt === "function") {
                await this.#hub.interrupt({ threadId: resolvedThreadId }).catch(() => {});
                let retryErr = error;
                for (const delayMs of [60, 140, 260]) {
                  await new Promise((r) => setTimeout(r, delayMs));
                  try {
                    await this.#hub.sendTurn({
                      threadId: resolvedThreadId,
                      text,
                      permissionMode: "turbo",
                      writerConflictPolicy: "reject",
                      steer: true,
                      ...turnModelOpts,
                    });
                    if (callId && resolvedThreadId) {
                      this.#registerDelegatedTask(callId, {
                        threadId: resolvedThreadId,
                        projectCwd: resolvedCwd,
                        projectName: targetName,
                        title: fuzzy.thread?.title || targetName,
                        instruction: text,
                        batchId,
                        queued: false,
                      });
                    }
                    return {
                      ok: true,
                      action: "send_turn",
                      executionTier: "external_thread",
                      dispatchMode: "immediate",
                      immediate: true,
                      interruptedPriorTurn: true,
                      queued: false,
                      focusThreadId: resolvedThreadId,
                      focusProjectCwd: resolvedCwd,
                      model: turnModelOpts.model || existingThreadModel,
                      summaryTag: `已停止等待并立即发送给 ${targetName}`,
                      spokenFeedback: "",
                      shouldSpeak: false,
                    };
                  } catch (err) {
                    retryErr = err;
                    if (Number(err?.status) !== 409) throw err;
                  }
                }
                throw retryErr;
              }
              throw error;
            }
          }
          try {
            await this.#hub.sendTurn({
              threadId: resolvedThreadId,
              text,
              permissionMode: "turbo",
              writerConflictPolicy: "reject",
              ...turnModelOpts,
            });
            if (callId && resolvedThreadId) {
              this.#registerDelegatedTask(callId, {
                threadId: resolvedThreadId,
                projectCwd: resolvedCwd,
                projectName: targetName,
                title: fuzzy.thread?.title || targetName,
                instruction: text,
                batchId,
                queued: false,
              });
            }
            return {
              ok: true,
              action: "send_turn",
              executionTier: "external_thread",
              dispatchMode: "queue",
              immediate: false,
              queued: false,
              focusThreadId: resolvedThreadId,
              focusProjectCwd: resolvedCwd,
              model: turnModelOpts.model || existingThreadModel,
              summaryTag: `已发送给 ${targetName}`,
              spokenFeedback: "",
              shouldSpeak: false,
            };
          } catch (error) {
            if (Number(error?.status) === 409) {
              await this.#hub.queueTurn({
                threadId: resolvedThreadId,
                text,
                permissionMode: "turbo",
                ...turnModelOpts,
              });
              if (callId && resolvedThreadId) {
                this.#registerDelegatedTask(callId, {
                  threadId: resolvedThreadId,
                  projectCwd: resolvedCwd,
                  projectName: targetName,
                  title: fuzzy.thread?.title || targetName,
                  instruction: text,
                  batchId,
                  queued: true,
                });
              }
              return {
                ok: true,
                action: "send_turn",
                executionTier: "external_thread",
                dispatchMode: "queue",
                immediate: false,
                queued: true,
                focusThreadId: resolvedThreadId,
                focusProjectCwd: resolvedCwd,
                model: turnModelOpts.model || existingThreadModel,
                summaryTag: "已加入排队，结束后自动执行",
                spokenFeedback: `${targetName} 当前会话正忙，已加入排队，上一轮完成后会自动执行。`,
                shouldSpeak: true,
              };
            }
            throw error;
          }
        },
      };
    }

    if (intent === "create_thread") {
      const text = plan.instruction || plan.heardText;
      return {
        needsBackground: true,
        pendingMeta: {
          action: "create_thread",
          executionTier: "external_thread",
          focusThreadId: "",
          focusProjectCwd: resolvedCwd,
          projectName: targetName,
          summaryTag: "正在新建任务",
          ackReply: `好的，正在 ${targetName} 新建任务。`,
        },
        execute: async ({ batchId = "" } = {}) => {
          const created = await this.#startBestThread({
            provider: plan.provider,
            model: plan.model,
            explicitFastHydrogen: Boolean(plan.explicitFastHydrogen),
            cwd: resolvedCwd,
            text,
            snapshot,
          });
          const createdId = created?.thread?.id || "";
          if (callId && createdId) {
            this.#registerDelegatedTask(callId, {
              threadId: createdId,
              projectCwd: resolvedCwd,
              projectName: targetName,
              title: created?.thread?.title || targetName,
              instruction: text,
              batchId,
              queued: false,
            });
          }
          return {
            ok: true,
            action: "create_thread",
            executionTier: "external_thread",
            focusThreadId: createdId,
            focusProjectCwd: resolvedCwd,
            model: created?.thread?.model || "",
            summaryTag: "已新建任务",
            spokenFeedback: `${targetName} 新任务已创建并开始运行。`,
            shouldSpeak: false,
          };
        },
      };
    }

    const hasExplicitTarget = Boolean(plan.targetThreadId || plan.targetProjectCwd);
    return {
      needsBackground: false,
      immediateResult: {
        ok: true,
        action: "summarize_progress",
        executionTier: "self_simple",
        focusThreadId: hasExplicitTarget ? (fuzzy.threadId || "") : "",
        focusProjectCwd: hasExplicitTarget ? (fuzzy.cwd || "") : "",
        summaryTag: hasExplicitTarget && fuzzy.threadId ? "已定位并播报进展" : "",
      },
    };
  }

  async #executeDispatchAction(plan, snapshot, { activeThreadId = "", callId = "" } = {}) {
    const prepared = this.#prepareDispatchAction(plan, snapshot, { activeThreadId, callId });
    if (!prepared.needsBackground) {
      return prepared.immediateResult;
    }
    return prepared.execute({ callId });
  }

  #startBackgroundDispatchBatch({
    callId = "",
    batchId = "",
    utteranceId = "",
    pendingMeta = {},
    execute,
  }) {
    const initialBatch = {
      batchId,
      callId,
      utteranceId,
      status: "dispatching",
      action: pendingMeta.action || "send_turn",
      executionTier: pendingMeta.executionTier || "external_thread",
      dispatchMode: pendingMeta.dispatchMode || "",
      immediate: Boolean(pendingMeta.immediate),
      focusThreadId: pendingMeta.focusThreadId || "",
      focusProjectCwd: pendingMeta.focusProjectCwd || "",
      projectName: pendingMeta.projectName || "",
      summaryTag: pendingMeta.summaryTag || "后台处理中",
      spokenFeedback: "",
      shouldSpeak: false,
      queued: false,
      priority: "normal",
      error: "",
      updatedAt: Date.now(),
    };
    this.#upsertDispatchBatch(callId, initialBatch);

    let subagentStep = 0;
    const emitProgress = (progressText, extra = {}) => {
      if (this.#closed) return;
      const cleanFeedback = stripSpeechNoise(progressText || "", 180);
      if (!cleanFeedback) return;
      subagentStep += 1;
      const evt = {
        callId,
        batchId,
        utteranceId,
        status: "running",
        action: initialBatch.action,
        executionTier: initialBatch.executionTier,
        step: subagentStep,
        summaryTag: extra.summaryTag || "Hydrogen 子代理进展",
        spokenFeedback: cleanFeedback,
        shouldSpeak: true,
        priority: "normal",
        updatedAt: Date.now(),
      };
      this.#upsertDispatchBatch(callId, {
        ...initialBatch,
        status: "running",
        summaryTag: evt.summaryTag,
        updatedAt: evt.updatedAt,
      });
      this.#emitEvent("voice_subagent_progress", evt);
    };

    const taskPromise = (async () => {
      try {
        const result = await execute({ batchId, utteranceId, emitProgress });
        const completedBatch = {
          ...initialBatch,
          status: result?.queued ? "queued" : "dispatched",
          action: result?.action || initialBatch.action,
          executionTier: result?.executionTier || initialBatch.executionTier,
          dispatchMode: result?.dispatchMode || initialBatch.dispatchMode || "",
          immediate: result?.immediate ?? initialBatch.immediate,
          interruptedPriorTurn: Boolean(result?.interruptedPriorTurn),
          steered: Boolean(result?.steered),
          focusThreadId: result?.focusThreadId || initialBatch.focusThreadId,
          focusProjectCwd: result?.focusProjectCwd || initialBatch.focusProjectCwd,
          model: result?.model || "",
          summaryTag: result?.summaryTag || initialBatch.summaryTag,
          spokenFeedback: stripSpeechNoise(result?.spokenFeedback || "", 260),
          shouldSpeak: Boolean(result?.shouldSpeak && result?.spokenFeedback),
          queued: Boolean(result?.queued),
          priority: result?.priority || "normal",
          error: "",
          updatedAt: Date.now(),
        };
        this.#upsertDispatchBatch(callId, completedBatch);
        this.#emitEvent("voice_dispatch", completedBatch);
        return completedBatch;
      } catch (error) {
        const errMsg = stripSpeechNoise(error?.message || "请稍后再试", 100);
        const failedBatch = {
          ...initialBatch,
          status: "failed",
          summaryTag: "执行失败",
          spokenFeedback: `后台执行未成功：${errMsg}`,
          shouldSpeak: true,
          priority: "critical",
          error: error?.message || "执行调度失败",
          updatedAt: Date.now(),
        };
        this.#upsertDispatchBatch(callId, failedBatch);
        this.#emitEvent("voice_dispatch", failedBatch);
        return failedBatch;
      }
    })();

    this.#pendingDispatchPromises.add(taskPromise);
    taskPromise.finally(() => {
      this.#pendingDispatchPromises.delete(taskPromise);
    });
    return taskPromise;
  }

  #registerDelegatedTask(callId, {
    threadId = "",
    projectCwd = "",
    projectName = "",
    title = "",
    instruction = "",
    batchId = "",
    queued = false,
  } = {}) {
    const cleanCallId = String(callId || "").trim();
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanCallId || !cleanThreadId) return;
    const state = this.#ensureCallState(cleanCallId);
    state.delegatedTasks.set(cleanThreadId, {
      threadId: cleanThreadId,
      projectCwd: String(projectCwd || "").trim(),
      projectName: String(projectName || "").trim() || (projectCwd ? basename(projectCwd) : "外部会话"),
      title: String(title || projectName || "任务").slice(0, 64),
      instruction: String(instruction || "").trim(),
      batchId: String(batchId || "").trim(),
      status: queued ? "queued" : "running",
      waveActive: true,
      dispatchedAt: Date.now(),
      completedAt: 0,
      lastResultSummary: "",
    });
  }

  #recordCompletedResult(callId, entry) {
    const cleanCallId = String(callId || "").trim();
    if (!cleanCallId || !entry) return;
    const state = this.#callStates.get(cleanCallId);
    if (!state) return;
    const cleanThreadId = String(entry.threadId || "").trim();
    state.completedResults = [
      entry,
      ...(state.completedResults || []).filter((item) => !cleanThreadId || item.threadId !== cleanThreadId),
    ].slice(0, 12);
  }

  async #runHubVoiceSubagent({
    target,
    instruction = "",
    snapshot = {},
    threadSnippet = "",
    targetCwd = "",
  }) {
    if (typeof this.#hub?.startThread !== "function") {
      return {
        provider: "local",
        model: "local-rules",
        summary: buildLocalSubagentSummary({ instruction, snapshot, threadSnippet }),
      };
    }

    const compactProjects = (snapshot?.projects || []).slice(0, 6).map((p) => ({
      name: p.alias || p.name,
      liveCount: p.liveCount,
      pendingCount: p.pendingCount,
      threads: (p.threads || []).slice(0, 2).map((t) => ({
        title: t.title,
        live: t.live,
        preview: t.preview,
      })),
    }));
    const subPrompt = [
      `${VOICE_CALL_TAG} 你是 Agent Control 的语音后台只读分析助手（${target.displayName}）。`,
      "请基于以下控制快照与会话摘录，在严禁修改任何代码文件的前提下，直接帮用户完成分析、整理、排查或结论总结。",
      "输出要求：用 2~4 句自然流畅的中文电话口语给出清晰结论与建议，不要包含 Markdown 符号、代码块或文件路径斜杠。",
      `用户请求：${instruction}`,
      ...(threadSnippet ? [`当前聚焦会话最近输出：${threadSnippet}`] : []),
      `<CONTEXT_SNAPSHOT>\n${JSON.stringify({ projects: compactProjects, pendingRequests: snapshot?.pendingRequests || [] })}\n</CONTEXT_SNAPSHOT>`,
    ].join("\n");

    const started = await this.#hub.startThread({
      provider: target.provider,
      profileId: target.profileId || "default",
      cwd: targetCwd || this.#workspaceDir,
      model: target.model || undefined,
      ...(target.effort ? { effort: target.effort } : {}),
      text: subPrompt,
      permissionMode: "turbo",
    });

    const createdThreadId = String(started?.thread?.id || "").trim();
    if (!createdThreadId) {
      throw new Error(`${target.displayName} 子代理未返回会话 ID`);
    }

    let summary = "";
    await new Promise((resolveDone, rejectDone) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        clearInterval(pollTimer);
        this.#pendingSubagentThreads.delete(createdThreadId);
      };
      const finish = (text) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveDone(String(text || "").trim());
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectDone(err);
      };

      const timeoutTimer = setTimeout(() => {
        fail(new Error(`${target.displayName} 子代理分析超时`));
      }, 45_000);

      const pollTimer = setInterval(async () => {
        if (settled || this.#closed) {
          fail(new Error("语音服务已关闭"));
          return;
        }
        if (typeof this.#hub?.readThread !== "function") return;
        const readRes = await this.#hub.readThread(createdThreadId, { limit: 4 }).catch(() => null);
        const latestThread = readRes?.thread;
        const turns = Array.isArray(latestThread?.turns) ? latestThread.turns : [];
        const lastTurn = turns[turns.length - 1];
        if (lastTurn && lastTurn.status && lastTurn.status !== "inProgress" && lastTurn.status !== "running") {
          const snippet = pickLatestAssistantSnippet(readRes);
          if (snippet || lastTurn.status === "completed") {
            finish(snippet || "已完成分析整理。");
          }
        }
      }, 900);
      pollTimer.unref?.();

      this.#pendingSubagentThreads.set(createdThreadId, {
        resolve: finish,
        reject: fail,
      });
    }).then((text) => {
      summary = text;
    });

    return {
      provider: target.provider,
      model: target.model || started?.thread?.model || "",
      summary: stripSpeechNoise(summary || "", 260) || "已完成分析整理。",
    };
  }

  async #runHydrogenSubagent({
    callId = "",
    batchId = "",
    utteranceId = "",
    instruction = "",
    snapshot = {},
    activeThreadId = "",
    projectCwd = "",
    preferredProvider = "",
    preferredModel = "",
    preferredProfileId = "",
    emitProgress = () => {},
  } = {}) {
    const target = await this.resolveVoiceTarget({
      callId,
      voiceProvider: preferredProvider,
      voiceModel: preferredModel,
      voiceProfileId: preferredProfileId,
    }).catch(async () => ({
      provider: "antigravity",
      profileId: "cli",
      model: await this.resolveHydrogenModel().catch(() => DEFAULT_VOICE_HYDROGEN_MODEL),
      effort: "low",
      shortLabel: "Hydrogen",
      displayName: "Hydrogen",
    }));
    const model = target.model || DEFAULT_VOICE_HYDROGEN_MODEL;
    const effort = target.effort || (/\b(low|fast|lite)\b|-low\b/i.test(model) ? "low" : "");
    const targetCwd = projectCwd && existsSync(projectCwd) ? projectCwd : this.#workspaceDir;
    let threadSnippet = "";
    if (activeThreadId && typeof this.#hub?.readThread === "function") {
      const threadRes = await this.#hub.readThread(activeThreadId, { limit: 6 }).catch(() => null);
      threadSnippet = pickLatestAssistantSnippet(threadRes);
    }

    const progressPrefix = target.provider === "antigravity"
      ? "Hydrogen 子代理进展"
      : `${target.shortLabel} 进展`;
    const stepMessages = [
      "正在收集相关会话与上下文信息",
      "正在深入分析并整理结论，很快给你结果",
      "正在核对细节与关键要点，马上完成",
    ];
    let lastTickAt = Date.now();
    let tickStep = 0;
    const progressTimer = setInterval(() => {
      if (this.#closed) return;
      if (Date.now() - lastTickAt < this.#subagentMinFeedbackGapMs) return;
      lastTickAt = Date.now();
      const msg = stepMessages[Math.min(tickStep, stepMessages.length - 1)];
      tickStep += 1;
      emitProgress(`${progressPrefix}：${msg}。`);
    }, this.#subagentProgressIntervalMs);

    try {
      if (this.#subagentExecutor) {
        const out = await this.#subagentExecutor({
          callId,
          batchId,
          utteranceId,
          instruction,
          provider: target.provider,
          model,
          effort,
          cwd: targetCwd,
          snapshot,
          threadSnippet,
          emitProgress: (msg) => {
            lastTickAt = Date.now();
            emitProgress(msg);
          },
        });
        return {
          provider: target.provider,
          model,
          summary: String(out?.summary || out?.text || out || "").trim(),
        };
      }

      if (target.provider === "local") {
        return {
          provider: "local",
          model: "local-rules",
          summary: buildLocalSubagentSummary({ instruction, snapshot, threadSnippet }),
        };
      }

      if (target.provider !== "antigravity") {
        return await this.#runHubVoiceSubagent({
          target,
          instruction,
          snapshot,
          threadSnippet,
          targetCwd,
        });
      }

      const client = await this.#ensureClient();
      const created = await client.newSession({ cwd: targetCwd });
      const sessionId = String(created?.sessionId || "");
      if (!sessionId) throw new Error("Hydrogen 子代理未返回会话 ID");
      await client.configureSession(sessionId, {
        model,
        ...(effort ? { effort } : {}),
        permissionMode: "readOnly",
      });

      const subBuffer = {
        callId,
        batchId,
        utteranceId,
        text: "",
        lastPhase: "",
        lastProgressAt: Date.now(),
        step: 0,
        emitProgress: (msg) => {
          lastTickAt = Date.now();
          emitProgress(msg);
        },
      };
      this.#activeSubagentSessions.set(sessionId, subBuffer);

      const compactProjects = (snapshot?.projects || []).slice(0, 6).map((p) => ({
        name: p.alias || p.name,
        liveCount: p.liveCount,
        pendingCount: p.pendingCount,
        threads: (p.threads || []).slice(0, 2).map((t) => ({
          title: t.title,
          live: t.live,
          preview: t.preview,
        })),
      }));
      const subPrompt = [
        "[AC_VOICE_SUBAGENT] 你是 Agent Control 的语音后台分析子代理（Hydrogen）。",
        "请基于以下控制快照与会话摘录，在不动手修改代码的前提下，直接帮用户完成分析、整理、排查或结论总结。",
        "输出要求：用 2~4 句自然流畅的中文电话口语给出清晰结论与建议，不要包含 Markdown 符号、代码块或文件路径斜杠。",
        `用户请求：${instruction}`,
        ...(threadSnippet ? [`当前聚焦会话最近输出：${threadSnippet}`] : []),
        `<CONTEXT_SNAPSHOT>\n${JSON.stringify({ projects: compactProjects, pendingRequests: snapshot?.pendingRequests || [] })}\n</CONTEXT_SNAPSHOT>`,
      ].join("\n");

      let timeoutTimer;
      try {
        await Promise.race([
          client.sendPrompt(sessionId, [{ type: "text", text: subPrompt }]),
          new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => reject(new Error("Hydrogen 子代理分析超时")), 45_000);
          }),
        ]);
      } finally {
        clearTimeout(timeoutTimer);
        this.#activeSubagentSessions.delete(sessionId);
      }

      const finalText = stripSpeechNoise(subBuffer.text || "", 260) || "已完成分析整理。";
      return { provider: "antigravity", model, summary: finalText };
    } finally {
      clearInterval(progressTimer);
    }
  }

  async handleHubEvent(eventName, payload) {
    if (this.#closed) return;
    if (eventName !== "provider_event" && eventName !== "turn_completed" && eventName !== "turn_started") {
      return;
    }
    const evt = payload || {};
    const threadId = String(evt.threadId || "").trim();
    if (!threadId) return;

    const isCodexStarted = evt.method === "turn/started";
    const isUnifiedStarted = evt.type === "turn_started" || eventName === "turn_started";
    const isCodexCompleted = evt.method === "turn/completed";
    const isUnifiedCompleted = evt.type === "turn_completed" || eventName === "turn_completed";

    if (isCodexStarted || isUnifiedStarted) {
      for (const state of this.#callStates.values()) {
        const delegated = state.delegatedTasks?.get(threadId);
        if (delegated) {
          delegated.status = "running";
          delegated.waveActive = true;
        }
      }
      return;
    }

    if (!isCodexCompleted && !isUnifiedCompleted) return;

    const rawStatus = isCodexCompleted
      ? (evt.params?.turn?.status || "completed")
      : (evt.status || "completed");
    const turnId = String(isCodexCompleted ? (evt.params?.turn?.id || "") : (evt.turnId || evt.turn?.id || "")).trim();
    let resultText = String(
      evt.lastAgentMessage
      || evt.params?.turn?.lastAgentMessage
      || "",
    ).trim();

    if (!resultText && typeof this.#hub?.readThread === "function") {
      const readRes = await this.#hub.readThread(threadId, { limit: 4 }).catch(() => null);
      resultText = pickLatestAssistantSnippet(readRes);
    }
    const cleanResultSummary = stripSpeechNoise(resultText, 240);

    const subagentWaiter = this.#pendingSubagentThreads.get(threadId);
    if (subagentWaiter) {
      if (rawStatus === "failed") {
        subagentWaiter.reject(new Error(evt.error || "语音后台分析子代理执行失败"));
      } else {
        subagentWaiter.resolve(cleanResultSummary || "已完成分析整理。");
      }
    }

    for (const state of this.#callStates.values()) {
      const delegated = state.delegatedTasks?.get(threadId);
      if (!delegated) continue;
      const dedupeKey = `milestone:${state.callId}:${threadId}:${turnId || `${rawStatus}:${Math.floor(Date.now() / 1000)}`}`;
      if (state.announcedMilestoneKeys?.has(dedupeKey)) continue;
      state.announcedMilestoneKeys?.add(dedupeKey);
      if (state.announcedMilestoneKeys && state.announcedMilestoneKeys.size > 100) {
        const firstKey = state.announcedMilestoneKeys.values().next().value;
        if (firstKey) state.announcedMilestoneKeys.delete(firstKey);
      }

      const label = delegated.projectName || delegated.title || "外部会话";
      delegated.status = rawStatus;
      delegated.completedAt = Date.now();
      delegated.lastResultSummary = cleanResultSummary;

      if (rawStatus === "interrupted") {
        delegated.waveActive = false;
        continue;
      }

      this.#recordCompletedResult(state.callId, {
        threadId,
        projectCwd: delegated.projectCwd || "",
        projectName: label,
        title: delegated.title || label,
        status: rawStatus,
        lastResultSummary: cleanResultSummary,
        completedAt: Date.now(),
        source: "external_thread",
      });

      const activeWaveItems = [];
      for (const item of state.delegatedTasks?.values() || []) {
        if (item.waveActive) activeWaveItems.push(item);
      }
      const remainingCount = activeWaveItems.filter(
        (item) => item.threadId !== threadId && (item.status === "running" || item.status === "queued"),
      ).length;
      const waveTotal = Math.max(1, activeWaveItems.length);
      const failed = rawStatus === "failed";

      // 对外派会话：绝不主动朗读详细结果内容，仅播报单个完成/全部完成里程碑
      let spokenFeedback = "";
      if (remainingCount > 0) {
        spokenFeedback = failed
          ? `「${label}」执行失败，还有 ${remainingCount} 个其他会话任务正在进行。`
          : `「${label}」已完成，还有 ${remainingCount} 个其他会话任务正在进行。`;
      } else {
        for (const item of activeWaveItems) {
          item.waveActive = false;
        }
        if (waveTotal > 1) {
          spokenFeedback = failed
            ? `「${label}」执行失败，本轮 ${waveTotal} 个其他会话任务已全部结束，需要听详情可以问我。`
            : `「${label}」已完成，本轮 ${waveTotal} 个其他会话任务已全部完成，需要听结果随时问我。`;
        } else {
          spokenFeedback = failed
            ? `「${label}」的任务执行失败，想了解详情随时问我。`
            : `「${label}」的任务已完成，想听结果随时问我。`;
        }
      }

      this.#emitEvent("voice_external_milestone", {
        callId: state.callId,
        threadId,
        turnId,
        projectName: label,
        status: rawStatus,
        remainingCount,
        totalCount: waveTotal,
        allDone: remainingCount === 0,
        resultStored: Boolean(cleanResultSummary),
        summaryTag: remainingCount === 0 ? "外部任务已全部完成" : "外部任务完成一个",
        spokenFeedback,
        shouldSpeak: true,
        priority: failed ? "critical" : "normal",
        dedupeKey,
        updatedAt: Date.now(),
      });
    }
  }

  async #startBestThread({
    provider = "",
    model = "",
    explicitFastHydrogen = false,
    cwd = "",
    text = "",
    snapshot,
  }) {
    const available = Array.isArray(snapshot?.availableProfiles) ? snapshot.availableProfiles : [];
    const fallbackAutoProvider = VOICE_LIGHT_PROVIDER_PRIORITY.find((prov) =>
      available.some((p) => p.provider === prov && p.authenticated !== false),
    ) || VOICE_LIGHT_PROVIDER_PRIORITY.find((prov) =>
      available.some((p) => p.provider === prov),
    ) || available.find((p) => p.authenticated !== false)?.provider
      || available[0]?.provider
      || "antigravity";
    const cleanProvider = ["antigravity", "codex", "claude", "grok"].includes(provider)
      ? provider
      : fallbackAutoProvider;
    const candidates = available.filter((p) => p.provider === cleanProvider);
    const chosenProfile = candidates.find((p) => p.authenticated !== false)
      || candidates[0]
      || available.find((p) => p.authenticated !== false)
      || available[0];
    const finalProvider = chosenProfile?.provider || cleanProvider;
    const finalProfileId = chosenProfile?.profileId || (finalProvider === "antigravity" ? "cli" : "default");
    const { model: resolvedModel, effort: resolvedEffort } = await this.#resolveTaskModelAndEffort({
      provider: finalProvider,
      requestedModel: model,
      explicitFastHydrogen: Boolean(explicitFastHydrogen),
    });
    return this.#hub.startThread({
      provider: finalProvider,
      profileId: finalProfileId,
      cwd,
      model: resolvedModel,
      ...(resolvedEffort ? { effort: resolvedEffort } : {}),
      text,
      permissionMode: "turbo",
    });
  }

  #resetAsrWorker(reason = "语音识别进程已退出") {
    const child = this.#asrChild;
    this.#asrChild = null;
    this.#asrReadyPromise = null;
    this.#asrStdoutBuf = "";
    if (child && !child.killed) {
      try { child.kill("SIGTERM"); } catch {}
    }
    for (const [reqId, pending] of this.#asrPending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.#asrPending.delete(reqId);
    }
  }

  #ensureAsrWorker() {
    if (this.#closed) {
      return Promise.reject(Object.assign(new Error("语音服务已关闭"), { status: 503 }));
    }
    if (this.#asrReadyPromise && this.#asrChild && !this.#asrChild.killed) {
      return this.#asrReadyPromise;
    }

    this.#asrReadyPromise = new Promise((resolveReady, rejectReady) => {
      const explicitBin = String(this.#env?.VOICE_ASR_BIN || process.env.VOICE_ASR_BIN || "").trim();
      const moduleDir = dirname(fileURLToPath(import.meta.url));
      const workerScript = resolve(moduleDir, "voice-asr-worker.py");
      const cmd = explicitBin || (this.#env?.VOICE_PYTHON_BIN || "/opt/homebrew/bin/python3.12");
      const args = explicitBin ? [] : [workerScript];

      let settledReady = false;
      const readyTimer = setTimeout(() => {
        if (!settledReady) {
          settledReady = true;
          this.#resetAsrWorker("本地 Whisper 启动超时");
          rejectReady(new Error("本地 Whisper 启动超时"));
        }
      }, 45_000);

      let child;
      try {
        child = spawn(cmd, args, {
          env: {
            ...this.#env,
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        clearTimeout(readyTimer);
        rejectReady(error);
        return;
      }

      this.#asrChild = child;
      let stderrTail = "";

      child.stderr.on("data", (chunk) => {
        stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-800);
      });

      child.stdout.on("data", (chunk) => {
        this.#asrStdoutBuf += chunk.toString("utf8");
        while (true) {
          const nl = this.#asrStdoutBuf.indexOf("\n");
          if (nl === -1) break;
          const line = this.#asrStdoutBuf.slice(0, nl).trim();
          this.#asrStdoutBuf = this.#asrStdoutBuf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (Object.hasOwn(msg, "ready") && !settledReady) {
            settledReady = true;
            clearTimeout(readyTimer);
            if (msg.ready) {
              resolveReady(child);
            } else {
              this.#resetAsrWorker(msg.error || "本地语音识别初始化失败");
              rejectReady(new Error(msg.error || "本地语音识别初始化失败"));
            }
            continue;
          }
          const reqId = String(msg?.id || "");
          if (reqId && this.#asrPending.has(reqId)) {
            const pending = this.#asrPending.get(reqId);
            this.#asrPending.delete(reqId);
            clearTimeout(pending.timer);
            if (msg.ok) {
              pending.resolve(msg);
            } else {
              pending.reject(new Error(msg.error || "语音识别失败"));
            }
          }
        }
      });

      child.on("error", (err) => {
        clearTimeout(readyTimer);
        if (!settledReady) {
          settledReady = true;
          rejectReady(err);
        }
        this.#resetAsrWorker(err?.message || "语音识别进程启动失败");
      });

      child.on("exit", (code, signal) => {
        clearTimeout(readyTimer);
        const reason = stderrTail.trim() || `语音识别进程退出 (${code ?? signal ?? "unknown"})`;
        if (!settledReady) {
          settledReady = true;
          rejectReady(new Error(reason));
        }
        this.#resetAsrWorker(reason);
      });
    });

    return this.#asrReadyPromise;
  }

  async transcribeAudio({
    audioBase64 = "",
    audioMimeType = "audio/wav",
    language = "zh",
    promptHints = "",
  } = {}) {
    const cleanAudio = String(audioBase64 || "").replace(/^data:[^;]+;base64,/, "").trim();
    if (!cleanAudio) {
      return { ok: true, text: "", engine: "none", durationMs: 0, noSpeech: true, silenceReason: "empty_audio" };
    }
    const buf = Buffer.from(cleanAudio, "base64");
    if (buf.length < 64) {
      return { ok: true, text: "", engine: "none", durationMs: 0, noSpeech: true, silenceReason: "too_short_audio" };
    }
    const asrBinName = basename(String(this.#env?.VOICE_ASR_BIN || "").trim());
    const isMockAsr = asrBinName.includes("mock-voice-asr");
    const wavCheck = analyzeWavPcm16Activity(buf, { allowLegacyZeroMockStub: isMockAsr });
    if (wavCheck.inspected && !wavCheck.hasSpeech) {
      return {
        ok: true,
        text: "",
        engine: "local-audio-gate",
        durationMs: wavCheck.durationMs,
        noSpeech: true,
        localAudioFiltered: true,
        silenceReason: wavCheck.reason,
      };
    }

    await mkdir(this.#utterancesDir, { recursive: true });
    const ext = extensionForAudioMime(audioMimeType);
    const audioPath = resolve(this.#utterancesDir, `asr-${randomUUID()}.${ext}`);
    await writeFile(audioPath, buf);

    try {
      const child = await this.#ensureAsrWorker();
      const reqId = randomUUID();
      const result = await new Promise((resolveReq, rejectReq) => {
        const timer = setTimeout(() => {
          this.#asrPending.delete(reqId);
          this.#resetAsrWorker("语音识别超时");
          rejectReq(new Error("语音识别超时"));
        }, 35_000);
        this.#asrPending.set(reqId, {
          resolve: resolveReq,
          reject: rejectReq,
          timer,
        });
        child.stdin.write(`${JSON.stringify({
          id: reqId,
          audioPath,
          language,
          ...(promptHints ? { prompt: promptHints } : {}),
        })}\n`);
      });
      const text = String(result?.text || "").trim();
      return {
        ok: true,
        text,
        engine: String(result?.engine || "mlx-whisper"),
        durationMs: Number(result?.durationMs) || 0,
        ...(result?.noSpeech || !text
          ? {
              noSpeech: true,
              silenceReason: String(result?.silenceReason || result?.reason || (!text ? "empty_transcript" : "no_speech")),
            }
          : {}),
      };
    } finally {
      await unlink(audioPath).catch(() => {});
    }
  }

  async handleTurn({
    callId = "",
    audioBase64 = "",
    audioMimeType = "audio/wav",
    transcriptText = "",
    activeThreadId = "",
    voiceProvider = "",
    voiceModel = "",
    voiceProfileId = "",
    mode = "turn",
    autoExecute = true,
    asyncDispatch = false,
    tts = true,
  } = {}) {
    const cleanCallId = String(callId || "").trim() || `call-${randomUUID().slice(0, 8)}`;
    const callState = this.#ensureCallState(cleanCallId);
    if (voiceProvider || voiceModel || voiceProfileId) {
      callState.voicePref = {
        voiceProvider: String(voiceProvider || "").trim(),
        voiceModel: String(voiceModel || "").trim(),
        voiceProfileId: String(voiceProfileId || "").trim(),
      };
    }
    const cleanAudio = String(audioBase64 || "").replace(/^data:[^;]+;base64,/, "").trim();
    const cleanTranscript = String(transcriptText || "").trim();
    const asrBinName = basename(String(this.#env?.VOICE_ASR_BIN || "").trim());
    const hasExplicitAsrBin = Boolean(asrBinName);
    const agyBinName = basename(agyExecutable(this.#env) || "");
    const isMockAgy = agyBinName.includes("mock-agy");
    const isMockAsr = asrBinName.includes("mock-voice-asr");

    const buildLocalNoSpeechPayload = ({
      silenceReason = "no_speech",
      ignoredText = "",
      model = "local-audio-gate",
      usedFallback = false,
      localAudioFiltered = false,
      audioMetrics = null,
      pendingCount = 0,
      liveProjectCount = 0,
    } = {}) => ({
      ok: true,
      noSpeech: true,
      localAudioFiltered,
      silenceReason,
      ...(audioMetrics ? { audioMetrics } : {}),
      callId: cleanCallId,
      model,
      usedFallback,
      heardText: "",
      ignoredText,
      spokenReply: "",
      utteranceId: "",
      expectedMs: 0,
      replayedUnheardIds: [],
      unheardCount: this.getUnheardUtterances(cleanCallId).length,
      batchId: "",
      dispatchPending: false,
      plan: {
        heardText: "",
        ignoredText,
        noSpeech: true,
        silenceReason,
        intent: "no_speech",
        targetProjectCwd: "",
        targetThreadId: "",
        provider: "",
        model: "",
        instruction: "",
        requestId: "",
        decision: "",
        spokenReply: "",
      },
      executed: { ok: true, action: "no_speech", noSpeech: true, summaryTag: "" },
      tts: { audioBase64: "", mimeType: "", provider: "none" },
      snapshotSummary: {
        pendingCount,
        liveProjectCount,
      },
    });

    if (mode !== "briefing") {
      if (!cleanAudio && !cleanTranscript) {
        return buildLocalNoSpeechPayload({
          silenceReason: "empty_input",
          model: "local-filter",
          localAudioFiltered: false,
        });
      }
      if (!cleanAudio && cleanTranscript) {
        const pendingList = this.#hub.allPendingRequests?.() || [];
        const speechCheck = classifyNonActionableSpeech(cleanTranscript, { hasPending: pendingList.length > 0 });
        if (speechCheck.noSpeech) {
          return buildLocalNoSpeechPayload({
            silenceReason: speechCheck.reason,
            ignoredText: cleanTranscript,
            model: "local-filter",
            localAudioFiltered: false,
            pendingCount: pendingList.length,
          });
        }
      }
      if (cleanAudio && !cleanTranscript) {
        const audioBuf = Buffer.from(cleanAudio, "base64");
        if (audioBuf.length < 64) {
          return buildLocalNoSpeechPayload({
            silenceReason: "too_short_audio",
            model: "local-audio-gate",
            localAudioFiltered: true,
          });
        }
        const wavCheck = analyzeWavPcm16Activity(audioBuf, {
          allowLegacyZeroMockStub: isMockAgy || isMockAsr,
        });
        if (wavCheck.inspected && !wavCheck.hasSpeech) {
          return buildLocalNoSpeechPayload({
            silenceReason: wavCheck.reason,
            model: "local-audio-gate",
            localAudioFiltered: true,
            audioMetrics: {
              durationMs: wavCheck.durationMs,
              rms: wavCheck.rms,
              peak: wavCheck.peak,
              maxFrameRms: wavCheck.maxFrameRms,
            },
          });
        }
      }
    }

    const unheardUtterances = this.getUnheardUtterances(cleanCallId, { includeStalePending: false });
    const lastUtterance = [...callState.utterances].reverse().find((u) => String(u?.text || "").trim()) || null;
    const snapshot = await this.buildLiveSnapshot({ activeThreadId, callId: cleanCallId });

    let plan;
    let usedFallback = false;
    let model = "";
    let engineLabel = "local-voice";

    if (!isMockAgy || hasExplicitAsrBin) {
      let heard = cleanTranscript;
      let asrResult = null;
      if (cleanAudio && !heard) {
        const projectNames = (snapshot.projects || [])
          .slice(0, 8)
          .map((p) => p.alias || p.name)
          .filter(Boolean);
        const promptHints = projectNames.length
          ? `以下是普通话简体中文语音指令，可能包含项目名称：${projectNames.join("、")}。常用指令：现在什么进度，跑一下测试，打开项目，批准请求，拒绝，停止运行，再说一遍。`
          : "";
        asrResult = await this.transcribeAudio({
          audioBase64: cleanAudio,
          audioMimeType,
          promptHints,
        });
        heard = String(asrResult?.text || "").trim();
        engineLabel = asrResult?.engine || engineLabel;
      }
      if (cleanAudio && !heard && mode !== "briefing") {
        return buildLocalNoSpeechPayload({
          silenceReason: String(asrResult?.silenceReason || "empty_transcript"),
          model: engineLabel,
          localAudioFiltered: Boolean(asrResult?.localAudioFiltered),
          pendingCount: snapshot.pendingRequests.length,
          liveProjectCount: snapshot.projects.filter((p) => p.liveCount > 0).length,
        });
      }
      plan = buildDeterministicVoicePlan({
        transcript: heard,
        snapshot,
        activeThreadId,
        mode,
        lastUtterance,
        unheardUtterances,
      });
      model = engineLabel;
    } else {
      const started = await this.startCall({ callId: cleanCallId });
      model = started.model;
      let utterancePath = "";

      try {
        if (cleanAudio) {
          await mkdir(this.#utterancesDir, { recursive: true });
          const ext = extensionForAudioMime(audioMimeType);
          utterancePath = resolve(this.#utterancesDir, `turn-${randomUUID()}.${ext}`);
          await writeFile(utterancePath, Buffer.from(cleanAudio, "base64"));
        }

        if (!started.warmed || !this.#calls.get(cleanCallId)?.sessionId) {
          usedFallback = true;
          plan = buildDeterministicVoicePlan({
            transcript: cleanTranscript || (mode === "briefing" ? "播报当前任务进度" : ""),
            snapshot,
            activeThreadId,
            mode,
            lastUtterance,
            unheardUtterances,
          });
        } else {
          const entry = this.#calls.get(cleanCallId);
          entry.lastUsedAt = Date.now();
          const promptText = this.#buildHydrogenPrompt({
            snapshot,
            audioFilePath: utterancePath,
            transcriptText: cleanTranscript,
            mode,
            unheardUtterances,
          });

          const rawResponse = await this.#runSerializedPrompt(entry.sessionId, promptText);
          plan = parseCoordinatorJson(rawResponse, cleanTranscript);
          if (!plan.spokenReply && !plan.noSpeech && plan.intent !== "no_speech") {
            plan.spokenReply = summarizeFallbackBriefing(snapshot);
          }
        }
      } catch (error) {
        this.#calls.delete(cleanCallId);
        throw error;
      } finally {
        if (utterancePath) {
          await unlink(utterancePath).catch(() => {});
        }
      }
    }

    if (plan?.noSpeech || plan?.intent === "no_speech") {
      return buildLocalNoSpeechPayload({
        silenceReason: plan.silenceReason || "no_speech",
        ignoredText: String(plan.ignoredText || cleanTranscript || "").trim(),
        model,
        usedFallback,
        localAudioFiltered: false,
        pendingCount: snapshot.pendingRequests.length,
        liveProjectCount: snapshot.projects.filter((p) => p.liveCount > 0).length,
      });
    }

    const executionTier = plan?.executionTier
      || classifyVoiceExecutionTier(plan?.instruction || plan?.heardText || "", { plan }).tier;
    const utteranceId = `utt-${randomUUID().slice(0, 10)}`;
    let executed = { ok: true, action: plan.intent, executionTier, summaryTag: "" };
    let pendingDispatchStart = null;
    let batchId = "";

    if (autoExecute && !usedFallback) {
      const prepared = this.#prepareDispatchAction(plan, snapshot, { activeThreadId, callId: cleanCallId });
      if (asyncDispatch || prepared.alwaysAsync) {
        if (!prepared.needsBackground) {
          executed = prepared.immediateResult;
          if (executed.overrideReply) {
            plan.spokenReply = executed.overrideReply;
          }
        } else {
          batchId = `batch-${randomUUID().slice(0, 10)}`;
          if (prepared.pendingMeta?.ackReply && (!plan.spokenReply || prepared.pendingMeta?.action === "subagent_hydrogen")) {
            plan.spokenReply = prepared.pendingMeta.ackReply;
          }
          executed = {
            ok: true,
            pending: true,
            batchId,
            action: prepared.pendingMeta.action,
            executionTier: prepared.pendingMeta.executionTier || executionTier,
            ...(prepared.pendingMeta.provider ? { provider: prepared.pendingMeta.provider } : {}),
            dispatchMode: prepared.pendingMeta.dispatchMode || "",
            immediate: Boolean(prepared.pendingMeta.immediate),
            focusThreadId: prepared.pendingMeta.focusThreadId,
            focusProjectCwd: prepared.pendingMeta.focusProjectCwd,
            summaryTag: prepared.pendingMeta.summaryTag,
          };
          pendingDispatchStart = {
            callId: cleanCallId,
            batchId,
            utteranceId,
            pendingMeta: prepared.pendingMeta,
            execute: prepared.execute,
          };
        }
      } else {
        try {
          executed = prepared.needsBackground
            ? await prepared.execute({ callId: cleanCallId })
            : prepared.immediateResult;
          if (executed.overrideReply) {
            plan.spokenReply = executed.overrideReply;
          }
        } catch (error) {
          executed = {
            ok: false,
            action: plan.intent,
            executionTier,
            error: error?.message || "执行调度失败",
            summaryTag: "执行失败",
          };
          plan.spokenReply = `操作未成功：${stripSpeechNoise(error?.message || "请稍后再试", 120)}`;
        }
      }
    }

    let replacesUtteranceIds = [];
    if (plan.intent === "repeat_last") {
      replacesUtteranceIds = unheardUtterances.map((u) => u.utteranceId);
      for (const u of unheardUtterances) {
        u.compensatedInTurn = true;
      }
    } else if (unheardUtterances.length > 0) {
      const eligibleMissed = unheardUtterances.filter((u) => ["turn", "briefing", "approval"].includes(String(u?.source || "turn")));
      const missed = eligibleMissed.find((u) => u.priority === "critical")
        || eligibleMissed[eligibleMissed.length - 1];
      if (missed && missed.text) {
        const rawMissedText = String(missed.text)
          .replace(/\s*另外补播刚才未听到的提醒：[\s\S]*$/, "")
          .trim();
        const missedSnippet = stripSpeechNoise(rawMissedText, 140);
        const currentReply = String(plan.spokenReply || "").trim();
        if (missedSnippet && !currentReply.includes(missedSnippet)) {
          plan.spokenReply = stripSpeechNoise(
            `${currentReply ? `${currentReply} ` : ""}另外补播刚才未听到的提醒：${missedSnippet}`,
            360,
          );
        }
        missed.compensatedInTurn = true;
        replacesUtteranceIds = [missed.utteranceId];
      }
    }

    const utterancePriority = (plan.intent === "approve_request" || (snapshot.pendingRequests?.length > 0 && plan.intent === "summarize_progress"))
      ? "critical"
      : "normal";
    const speechResult = tts
      ? await this.synthesizeSpeech({
          text: plan.spokenReply,
          callId: cleanCallId,
          utteranceId,
          source: mode === "briefing" ? "briefing" : "turn",
          priority: utterancePriority,
          register: false,
        })
      : {
          audioBase64: "",
          mimeType: "",
          provider: "none",
          text: plan.spokenReply,
          utteranceId,
          expectedMs: estimateSpeechDurationMs(plan.spokenReply),
        };

    const uttRecord = this.registerUtterance({
      callId: cleanCallId,
      utteranceId: speechResult.utteranceId || utteranceId,
      text: plan.spokenReply,
      source: mode === "briefing" ? "briefing" : "turn",
      intent: plan.intent,
      priority: utterancePriority,
      provider: speechResult.provider,
      replacesUtteranceIds,
    });
    const currentUnheard = this.getUnheardUtterances(cleanCallId);

    if (pendingDispatchStart) {
      this.#startBackgroundDispatchBatch({
        ...pendingDispatchStart,
        utteranceId: uttRecord.utteranceId,
      });
    }

    return {
      ok: true,
      callId: cleanCallId,
      model,
      usedFallback,
      heardText: plan.heardText,
      spokenReply: plan.spokenReply,
      utteranceId: uttRecord.utteranceId,
      expectedMs: uttRecord.expectedMs,
      replayedUnheardIds: replacesUtteranceIds,
      unheardCount: currentUnheard.length,
      batchId,
      dispatchPending: Boolean(pendingDispatchStart),
      executionTier: executed?.executionTier || executionTier,
      dispatchMode: executed?.dispatchMode || plan?.dispatchMode || "",
      queued: Boolean(executed?.queued),
      plan,
      executed,
      tts: {
        audioBase64: speechResult.audioBase64,
        mimeType: speechResult.mimeType,
        provider: speechResult.provider,
      },
      snapshotSummary: {
        pendingCount: snapshot.pendingRequests.length,
        liveProjectCount: snapshot.projects.filter((p) => p.liveCount > 0).length,
      },
    };
  }

  #runSerializedPrompt(sessionId, promptText) {
    const exec = async () => {
      const client = await this.#ensureClient();
      const buffer = { text: "" };
      this.#activeSessionTurn.set(sessionId, buffer);
      let timer;
      try {
        await Promise.race([
          client.sendPrompt(sessionId, [{ type: "text", text: promptText }]),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Hydrogen 语音协调超时")), VOICE_PROMPT_TIMEOUT_MS);
          }),
        ]);
        return buffer.text;
      } finally {
        clearTimeout(timer);
        this.#activeSessionTurn.delete(sessionId);
      }
    };
    const next = this.#turnQueue.then(exec, exec);
    this.#turnQueue = next.catch(() => {});
    return next;
  }

  async close() {
    this.#closed = true;
    if (this.#pendingDispatchPromises.size > 0) {
      await Promise.allSettled([...this.#pendingDispatchPromises]);
    }
    this.#calls.clear();
    this.#callStates.clear();
    this.#ttsCache.clear();
    this.#activeSessionTurn.clear();
    this.#activeSubagentSessions.clear();
    for (const waiter of this.#pendingSubagentThreads.values()) {
      waiter.reject(new Error("语音通话服务已关闭"));
    }
    this.#pendingSubagentThreads.clear();
    this.#resetAsrWorker("语音通话服务已关闭");
    if (this.#client) {
      await this.#client.close().catch(() => {});
      this.#client = null;
    }
  }
}
