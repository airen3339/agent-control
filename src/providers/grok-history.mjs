import { constants as fsConstants } from "node:fs";
import { access, open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, resolve } from "node:path";
import { normalizePlatform, resolveUserHome } from "../platform.mjs";
import { cleanPreviewText, stripPromptNoise } from "../thread-display.mjs";
import { isContinuationOrControlPrompt } from "../thread-title.mjs";

const HEAD_TAIL_BYTES = 24 * 1024;

async function pathExists(targetPath) {
  if (!targetPath) return false;
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function parseGrokTimestampSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

export function decodeGrokCwdSlug(slug) {
  const raw = String(slug || "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function defaultGrokDesktopIndexPath(env = process.env, platform = process.platform) {
  const normalizedPlatform = normalizePlatform(platform);
  const home = resolveUserHome(env, normalizedPlatform) || os.homedir();
  if (normalizedPlatform === "darwin") {
    return resolve(home, "Library", "Application Support", "com.grokapp.grok-app", "sessions_index.json");
  }
  if (normalizedPlatform === "win32") {
    const appData = env.APPDATA || resolve(home, "AppData", "Roaming");
    return resolve(appData, "com.grokapp.grok-app", "sessions_index.json");
  }
  const configHome = env.XDG_CONFIG_HOME || resolve(home, ".config");
  return resolve(configHome, "com.grokapp.grok-app", "sessions_index.json");
}

function extractRawTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === "string") {
      parts.push(block);
    } else if (block.type === "text" || block.type === "input_text") {
      if (typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * 剥离 Grok CLI 在用户消息首条注入的 <user_info>、<rules>、<system-reminder> 与 <user_query> 包裹标签
 */
export function stripGrokInjectedUserInfo(rawText) {
  let text = String(rawText || "");
  if (!text.trim()) return "";

  const queryMatches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)];
  if (queryMatches.length > 0) {
    text = queryMatches.map((m) => m[1] || "").filter(Boolean).join("\n\n");
  } else {
    text = text
      .replace(/<user_info>[\s\S]*?<\/user_info>/gi, "")
      .replace(/<rules>[\s\S]*?<\/rules>/gi, "")
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
      .replace(/<\/?user_query>/gi, "");
  }

  return stripPromptNoise(text.trim()).trim();
}

function extractUserContentBlocks(content) {
  const blocks = [];
  if (typeof content === "string") {
    const text = stripGrokInjectedUserInfo(content);
    if (text) blocks.push({ type: "text", text });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const part of content) {
    if (!part) continue;
    if (typeof part === "string") {
      const text = stripGrokInjectedUserInfo(part);
      if (text) blocks.push({ type: "text", text });
      continue;
    }
    if (part.type === "text" || part.type === "input_text") {
      const text = stripGrokInjectedUserInfo(part.text || "");
      if (text) blocks.push({ type: "text", text });
    } else if (part.type === "image_url" || part.type === "image" || part.type === "input_image") {
      blocks.push({ type: "image", label: "[图片]" });
    }
  }
  return blocks;
}

function isSyntheticHelperPrompt(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith("为下面这条用户消息起一个简短会话标题")
    || trimmed.startsWith("[AGENT_CONTROL_PING]")
  );
}

async function readHeadTailLines(filePath, fileSize) {
  if (!fileSize || fileSize <= 0) return [];
  const fh = await open(filePath, "r");
  try {
    if (fileSize <= HEAD_TAIL_BYTES * 2) {
      const buf = Buffer.alloc(fileSize);
      await fh.read(buf, 0, fileSize, 0);
      return buf.toString("utf8").split("\n").filter(Boolean);
    }
    const headBuf = Buffer.alloc(HEAD_TAIL_BYTES);
    await fh.read(headBuf, 0, HEAD_TAIL_BYTES, 0);
    const tailStart = Math.max(0, fileSize - HEAD_TAIL_BYTES);
    const tailLen = fileSize - tailStart;
    const tailBuf = Buffer.alloc(tailLen);
    await fh.read(tailBuf, 0, tailLen, tailStart);
    const headLines = headBuf.toString("utf8").split("\n");
    headLines.pop();
    const tailLines = tailBuf.toString("utf8").split("\n");
    if (tailStart > 0) tailLines.shift();
    return [...headLines, ...tailLines].filter(Boolean);
  } finally {
    await fh.close();
  }
}

function parseToolCallArguments(rawArgs) {
  if (rawArgs && typeof rawArgs === "object") return rawArgs;
  const text = String(rawArgs || "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { raw: text };
  } catch {
    return { raw: text };
  }
}

function mapGrokToolCallToItem(toolCall, index = 0) {
  const id = String(toolCall?.id || `grok-tool-${index}`);
  const name = String(toolCall?.name || "tool");
  const lower = name.toLowerCase();
  const args = parseToolCallArguments(toolCall?.arguments);

  if (lower === "bash" || lower === "shell" || lower === "run_command" || lower === "exec_command") {
    return {
      type: "commandExecution",
      id,
      command: String(args.command || args.cmd || args.script || name),
      cwd: args.cwd ? String(args.cwd) : undefined,
      aggregatedOutput: "",
      status: "completed",
      tool: name,
    };
  }

  if (
    lower === "write_file"
    || lower === "edit_file"
    || lower === "create_file"
    || lower === "str_replace"
    || lower === "apply_patch"
    || lower === "delete_file"
    || lower === "insert_lines"
  ) {
    const filePath = String(args.path || args.file_path || args.target_file || args.file || "");
    return {
      type: "fileChange",
      id,
      changes: filePath ? [{ path: filePath, kind: lower }] : [],
      status: "completed",
      tool: name,
    };
  }

  return {
    type: "mcpToolCall",
    id,
    server: "grok",
    tool: name,
    arguments: args,
    result: null,
    status: "completed",
  };
}

function formatToolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : item?.text || JSON.stringify(item)))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return "";
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  async function worker() {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export class GrokHistoryIndex {
  #cache = new Map();
  #desktopCache = { path: "", mtimeMs: 0, size: 0, byAgentId: new Map() };
  #env;
  #platform;
  #desktopIndexPath;

  constructor({ env = process.env, platform = process.platform, desktopIndexPath = null } = {}) {
    this.#env = env;
    this.#platform = normalizePlatform(platform);
    this.#desktopIndexPath = desktopIndexPath;
  }

  async #loadDesktopIndex() {
    const targetPath = this.#desktopIndexPath !== null
      ? this.#desktopIndexPath
      : defaultGrokDesktopIndexPath(this.#env, this.#platform);
    if (!targetPath) return new Map();
    const info = await stat(targetPath).catch(() => null);
    if (!info || !info.isFile()) return new Map();
    if (
      this.#desktopCache.path === targetPath
      && this.#desktopCache.mtimeMs === info.mtimeMs
      && this.#desktopCache.size === info.size
    ) {
      return this.#desktopCache.byAgentId;
    }

    const byAgentId = new Map();
    try {
      const rows = JSON.parse(await readFile(targetPath, "utf8"));
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const agentSessionId = String(row?.agentSessionId || "").trim();
          if (!agentSessionId) continue;
          byAgentId.set(agentSessionId, {
            title: String(row?.title || "").trim(),
            createdAt: parseGrokTimestampSeconds(row?.createdAt),
            updatedAt: parseGrokTimestampSeconds(row?.updatedAt),
            archived: Boolean(row?.archived),
            modelId: String(row?.modelId || "").trim(),
            effort: String(row?.effort || "").trim(),
          });
        }
      }
    } catch {
      // Ignore corrupt desktop index
    }
    this.#desktopCache = { path: targetPath, mtimeMs: info.mtimeMs, size: info.size, byAgentId };
    return byAgentId;
  }

  async #summarizeSessionDir(sessionDir, cwdSlug, rawId, desktopById) {
    const summaryPath = resolve(sessionDir, "summary.json");
    const chatPath = resolve(sessionDir, "chat_history.jsonl");
    const [sumStat, chatStat] = await Promise.all([
      stat(summaryPath).catch(() => null),
      stat(chatPath).catch(() => null),
    ]);
    if (!sumStat && !chatStat) return null;

    const desktopEntry = desktopById.get(rawId) || null;
    const sumMtimeMs = sumStat ? sumStat.mtimeMs : 0;
    const chatMtimeMs = chatStat ? chatStat.mtimeMs : 0;
    const chatSize = chatStat ? chatStat.size : 0;
    const desktopUpdated = desktopEntry?.updatedAt || 0;
    const desktopTitle = desktopEntry?.title || "";

    const cached = this.#cache.get(sessionDir);
    if (
      cached
      && cached.sumMtimeMs === sumMtimeMs
      && cached.chatMtimeMs === chatMtimeMs
      && cached.chatSize === chatSize
      && cached.desktopUpdated === desktopUpdated
      && cached.desktopTitle === desktopTitle
    ) {
      return cached.summary;
    }

    let summaryJson = null;
    if (sumStat && sumStat.isFile()) {
      try {
        summaryJson = JSON.parse(await readFile(summaryPath, "utf8"));
      } catch {
        summaryJson = null;
      }
    }

    const rawGeneratedTitle = String(summaryJson?.generated_title || "").trim();
    const rawSessionSummary = String(summaryJson?.session_summary || "").trim();
    if (isSyntheticHelperPrompt(rawGeneratedTitle)) {
      this.#cache.set(sessionDir, { sumMtimeMs, chatMtimeMs, chatSize, desktopUpdated, desktopTitle, summary: null });
      return null;
    }

    let firstUserText = "";
    let lastUserText = "";
    let lastSubstantiveUserText = "";
    let userTurnCount = 0;
    let hasConversation = Boolean(summaryJson?.num_chat_messages && Number(summaryJson.num_chat_messages) > 0);
    let modelFromChat = "";
    let effortFromChat = "";
    let minTs = 0;
    let maxTs = 0;

    if (chatStat && chatStat.isFile()) {
      const lines = await readHeadTailLines(chatPath, chatStat.size).catch(() => []);
      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!entry || typeof entry !== "object") continue;
        const ts = parseGrokTimestampSeconds(entry.timestamp || entry.created_at);
        if (ts > 0) {
          if (!minTs || ts < minTs) minTs = ts;
          if (ts > maxTs) maxTs = ts;
        }
        if (entry.type === "user" && !entry.synthetic_reason) {
          const text = stripGrokInjectedUserInfo(extractRawTextFromContent(entry.content));
          if (text) {
            if (entry.prompt_index !== undefined || !firstUserText) {
              hasConversation = true;
              userTurnCount += 1;
              if (!firstUserText) firstUserText = text;
              lastUserText = text;
              if (!isContinuationOrControlPrompt(text)) {
                lastSubstantiveUserText = text;
              }
            }
          }
        } else if (entry.type === "assistant") {
          hasConversation = true;
          if (entry.model_id) modelFromChat = String(entry.model_id).trim();
          if (entry.reasoning_effort) effortFromChat = String(entry.reasoning_effort).trim();
        }
      }
    }

    if (isSyntheticHelperPrompt(firstUserText) || isSyntheticHelperPrompt(lastUserText)) {
      this.#cache.set(sessionDir, { sumMtimeMs, chatMtimeMs, chatSize, desktopUpdated, desktopTitle, summary: null });
      return null;
    }

    if (!hasConversation && !rawGeneratedTitle && !rawSessionSummary && !desktopTitle) {
      this.#cache.set(sessionDir, { sumMtimeMs, chatMtimeMs, chatSize, desktopUpdated, desktopTitle, summary: null });
      return null;
    }

    const sessionId = String(summaryJson?.info?.id || rawId).trim() || rawId;
    const cwd = String(summaryJson?.info?.cwd || summaryJson?.git_root_dir || decodeGrokCwdSlug(cwdSlug) || "").trim() || os.homedir();
    const headBranch = String(summaryJson?.head_branch || "").trim();
    const createdAt = parseGrokTimestampSeconds(summaryJson?.created_at)
      || desktopEntry?.createdAt
      || minTs
      || Math.floor(((sumStat?.birthtimeMs || chatStat?.birthtimeMs || sumMtimeMs || chatMtimeMs || Date.now())) / 1000);
    const updatedAt = Math.max(
      parseGrokTimestampSeconds(summaryJson?.last_active_at || summaryJson?.updated_at),
      desktopUpdated,
      maxTs,
      Math.floor(Math.max(sumMtimeMs, chatMtimeMs) / 1000),
    );
    const name = rawGeneratedTitle || desktopTitle || rawSessionSummary || "";
    const previewSource = lastUserText || firstUserText || rawSessionSummary || desktopTitle || rawGeneratedTitle || "";
    const summary = {
      id: sessionId,
      filePath: chatStat ? chatPath : summaryPath,
      sessionDir,
      cwd,
      gitInfo: headBranch ? { branch: headBranch } : null,
      createdAt,
      updatedAt,
      name,
      firstUserText,
      lastUserText: lastSubstantiveUserText || lastUserText,
      hasFollowUpTurns: userTurnCount > 1,
      preview: cleanPreviewText(previewSource, 120),
      model: String(summaryJson?.current_model_id || modelFromChat || desktopEntry?.modelId || "").trim(),
      reasoningEffort: String(summaryJson?.reasoning_effort || effortFromChat || desktopEntry?.effort || "").trim().toLowerCase(),
      archived: Boolean(desktopEntry?.archived),
    };

    this.#cache.set(sessionDir, { sumMtimeMs, chatMtimeMs, chatSize, desktopUpdated, desktopTitle, summary });
    return summary;
  }

  async findSession(grokHome, rawId) {
    const cleanId = String(rawId || "").trim();
    if (!grokHome || !cleanId) return null;
    const sessionsDir = resolve(grokHome, "sessions");
    const level1 = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    for (const d1 of level1) {
      if (!d1.isDirectory()) continue;
      if (d1.name === cleanId) {
        const directDir = resolve(sessionsDir, d1.name);
        if (await pathExists(resolve(directDir, "chat_history.jsonl")) || await pathExists(resolve(directDir, "summary.json"))) {
          return { sessionDir: directDir, cwdSlug: "", rawId: cleanId };
        }
      }
      const candidate = resolve(sessionsDir, d1.name, cleanId);
      if (await pathExists(resolve(candidate, "chat_history.jsonl")) || await pathExists(resolve(candidate, "summary.json"))) {
        return { sessionDir: candidate, cwdSlug: d1.name, rawId: cleanId };
      }
    }
    return null;
  }

  async listSessions(grokHome, { limit = 300 } = {}) {
    if (!grokHome) return [];
    const sessionsDir = resolve(grokHome, "sessions");
    const level1 = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    if (level1.length === 0) return [];

    const desktopById = await this.#loadDesktopIndex();
    const entries = [];
    for (const d1 of level1) {
      if (!d1.isDirectory()) continue;
      const p1 = resolve(sessionsDir, d1.name);
      const level2 = await readdir(p1, { withFileTypes: true }).catch(() => []);
      if (level2.some((item) => item.isFile() && (item.name === "summary.json" || item.name === "chat_history.jsonl"))) {
        entries.push({ sessionDir: p1, cwdSlug: "", rawId: d1.name });
        continue;
      }
      for (const d2 of level2) {
        if (!d2.isDirectory()) continue;
        entries.push({ sessionDir: resolve(p1, d2.name), cwdSlug: d1.name, rawId: d2.name });
      }
    }

    const summarized = await mapWithConcurrency(
      entries,
      12,
      ({ sessionDir, cwdSlug, rawId }) => this.#summarizeSessionDir(sessionDir, cwdSlug, rawId, desktopById),
    );

    const seenIds = new Set();
    const items = [];
    for (const item of summarized) {
      if (!item || item.archived) continue;
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      items.push(item);
    }

    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return items.slice(0, Math.max(1, limit));
  }
}

function parseTurnCursor(cursor) {
  const match = String(cursor || "").trim().match(/^turn:(\d+)$/);
  return match ? Number(match[1]) : null;
}

export async function readGrokThreadHistory(
  grokHome,
  rawId,
  { index = new GrokHistoryIndex(), cursor = null, limit = 40 } = {},
) {
  const cleanId = String(rawId || "").trim();
  const located = await index.findSession(grokHome, cleanId);
  if (!located) return null;

  const { sessionDir, cwdSlug } = located;
  const summaryPath = resolve(sessionDir, "summary.json");
  const chatPath = resolve(sessionDir, "chat_history.jsonl");

  const [sumStat, chatStat, summaryText, chatRaw] = await Promise.all([
    stat(summaryPath).catch(() => null),
    stat(chatPath).catch(() => null),
    readFile(summaryPath, "utf8").catch(() => ""),
    readFile(chatPath, "utf8").catch(() => ""),
  ]);

  let summaryJson = null;
  if (summaryText) {
    try {
      summaryJson = JSON.parse(summaryText);
    } catch {
      summaryJson = null;
    }
  }

  const turns = [];
  let currentTurn = null;
  let toolMap = new Map();
  let modelFromChat = "";
  let effortFromChat = "";
  let firstUserPreview = "";
  let firstUserText = "";
  let lastUserText = "";
  let lastSubstantiveUserText = "";
  let userTurnCount = 0;

  const ensureTurn = () => {
    if (!currentTurn) {
      currentTurn = {
        id: `grok-turn-${turns.length + 1}`,
        status: "completed",
        items: [],
        error: null,
      };
      toolMap = new Map();
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  const lines = chatRaw.split("\n").filter(Boolean);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    let entry;
    try {
      entry = JSON.parse(lines[lineIdx]);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    if (entry.type === "user") {
      if (entry.synthetic_reason) continue;
      const blocks = extractUserContentBlocks(entry.content);
      const textOnly = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (entry.prompt_index === undefined && !textOnly) continue;
      if (blocks.length === 0) continue;
      if (!firstUserPreview && textOnly) firstUserPreview = textOnly;
      if (textOnly) {
        userTurnCount += 1;
        if (!firstUserText) firstUserText = textOnly;
        lastUserText = textOnly;
        if (!isContinuationOrControlPrompt(textOnly)) {
          lastSubstantiveUserText = textOnly;
        }
      }
      currentTurn = {
        id: entry.prompt_index !== undefined ? `grok-turn-${entry.prompt_index}` : `grok-turn-${turns.length + 1}`,
        status: "completed",
        items: [{
          type: "userMessage",
          id: `grok-user-${lineIdx}`,
          content: blocks,
        }],
        error: null,
      };
      toolMap = new Map();
      turns.push(currentTurn);
      continue;
    }

    if (entry.type === "reasoning") {
      // Strictly ignore encrypted_content
      const summaryTexts = Array.isArray(entry.summary)
        ? entry.summary.map((s) => String(s?.text || "").trim()).filter(Boolean)
        : [];
      if (summaryTexts.length === 0) continue;
      const turn = ensureTurn();
      turn.items.push({
        type: "reasoning",
        id: String(entry.id || `grok-reason-${lineIdx}`),
        summary: summaryTexts,
        content: [],
      });
      continue;
    }

    if (entry.type === "assistant") {
      if (entry.model_id) modelFromChat = String(entry.model_id).trim();
      if (entry.reasoning_effort) effortFromChat = String(entry.reasoning_effort).trim().toLowerCase();
      const turn = ensureTurn();
      if (entry.model_id) turn.model = String(entry.model_id).trim();
      if (entry.reasoning_effort) turn.effort = String(entry.reasoning_effort).trim().toLowerCase();
      const text = typeof entry.content === "string" ? entry.content : "";
      if (text) {
        turn.items.push({
          type: "agentMessage",
          id: `grok-msg-${lineIdx}`,
          text,
        });
      }
      if (Array.isArray(entry.tool_calls)) {
        for (let tcIdx = 0; tcIdx < entry.tool_calls.length; tcIdx += 1) {
          const item = mapGrokToolCallToItem(entry.tool_calls[tcIdx], `${lineIdx}-${tcIdx}`);
          toolMap.set(item.id, item);
          turn.items.push(item);
        }
      }
      continue;
    }

    if (entry.type === "tool_result") {
      const target = toolMap.get(String(entry.tool_call_id || ""));
      if (!target) continue;
      const text = formatToolResultText(entry.content);
      const isErr = Boolean(entry.is_error || entry.error || entry.status === "error");
      if (target.type === "commandExecution") {
        target.aggregatedOutput = target.aggregatedOutput ? `${target.aggregatedOutput}\n${text}` : text;
      } else if (target.type === "fileChange") {
        if (text) target.output = text;
      } else {
        target.result = { content: [{ type: "text", text }] };
      }
      target.status = isErr ? "failed" : "completed";
    }
  }

  const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 40));
  const totalTurns = turns.length;
  const cursorEnd = parseTurnCursor(cursor);
  const endIndex = cursorEnd !== null ? Math.min(totalTurns, cursorEnd) : totalTurns;
  const startIndex = Math.max(0, endIndex - normalizedLimit);
  const slicedTurns = turns.slice(startIndex, endIndex);
  const hasMore = startIndex > 0;
  const nextCursor = hasMore ? `turn:${startIndex}` : null;

  const cwd = String(summaryJson?.info?.cwd || summaryJson?.git_root_dir || decodeGrokCwdSlug(cwdSlug) || "").trim() || os.homedir();
  const createdAt = parseGrokTimestampSeconds(summaryJson?.created_at)
    || Math.floor(((sumStat?.birthtimeMs || chatStat?.birthtimeMs || Date.now())) / 1000);
  const updatedAt = parseGrokTimestampSeconds(summaryJson?.last_active_at || summaryJson?.updated_at)
    || Math.floor(Math.max(sumStat?.mtimeMs || 0, chatStat?.mtimeMs || 0) / 1000);
  const name = String(summaryJson?.generated_title || "").trim();

  const thread = {
    id: String(summaryJson?.info?.id || cleanId),
    cwd,
    gitInfo: summaryJson?.head_branch ? { branch: String(summaryJson.head_branch) } : null,
    createdAt,
    updatedAt,
    name: isSyntheticHelperPrompt(name) ? "" : name,
    firstUserText,
    lastUserText: lastSubstantiveUserText || lastUserText,
    hasFollowUpTurns: userTurnCount > 1,
    preview: cleanPreviewText(String(summaryJson?.session_summary || "").trim() || lastUserText || firstUserPreview || name, 120),
    model: String(summaryJson?.current_model_id || modelFromChat || "").trim(),
    reasoningEffort: String(summaryJson?.reasoning_effort || effortFromChat || "").trim().toLowerCase(),
    filePath: chatStat ? chatPath : summaryPath,
  };

  return {
    thread,
    turns: slicedTurns,
    nextCursor,
    hasMore,
    totalTurns,
  };
}
