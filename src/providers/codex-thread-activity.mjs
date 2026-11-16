import { open } from "node:fs/promises";

const MAX_TAIL_BYTES = 256 * 1024;
const CODEX_RUNNING_INFER_WINDOW_MS = 180_000;
const CODEX_STALE_RUNNING_GUARD_MS = 15 * 60 * 1000;

function extractReasoningSummaryText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.text === "string" && payload.text.trim()) return payload.text.trim();
  if (Array.isArray(payload.summary)) {
    const joined = payload.summary
      .map((part) => (typeof part?.text === "string" ? part.text.trim() : ""))
      .filter(Boolean)
      .join(" ");
    if (joined) return joined;
  }
  return "";
}

function extractResponseMessageText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
  if (Array.isArray(payload.content)) {
    const joined = payload.content
      .map((part) => (typeof part?.text === "string" ? part.text.trim() : ""))
      .filter(Boolean)
      .join(" ");
    if (joined) return joined;
  }
  return "";
}

function phaseFromCompletedItem(item) {
  const itemType = String(item?.type || "");
  if (itemType === "Reasoning") return "思考中";
  if (itemType === "CommandExecution") return "执行命令";
  if (itemType === "AgentMessage") return "生成回复";
  if (itemType === "UserMessage") return "已收到指令";
  return "Codex 执行中";
}

function summarizeRolloutActivity(lines, { mtimeMs = 0, nowMs = Date.now() } = {}) {
  let turnId = "";
  let status = "idle";
  let phase = "";
  let text = "";
  let updatedAt = 0;
  let sawExplicitStarted = false;
  let sawTerminal = false;
  let sawActivityAfterTerminal = false;
  let tailPhase = "";
  let tailText = "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Math.floor((Date.parse(record?.timestamp || "") || Date.now()) / 1000);
    updatedAt = Math.max(updatedAt, ts);
    const payload = record?.payload || {};

    if (record?.type === "token_usage_record") {
      if (record.turn_id) turnId = record.turn_id;
      if (!sawTerminal) sawActivityAfterTerminal = true;
      continue;
    }

    if (record?.type === "response_item") {
      const pType = String(payload.type || "");
      if (!pType) continue;
      sawTerminal = false;
      sawActivityAfterTerminal = true;
      if (pType === "reasoning") {
        tailPhase = "思考中";
        const snippet = extractReasoningSummaryText(payload);
        if (snippet) tailText = snippet.slice(-240);
      } else if (pType === "function_call" || pType === "custom_tool_call") {
        tailPhase = payload.name ? `调用 ${payload.name}` : "执行工具";
        const argPreview = typeof payload.input === "string"
          ? payload.input
          : (typeof payload.arguments === "string" ? payload.arguments : "");
        tailText = argPreview.replace(/\s+/g, " ").trim().slice(0, 180);
      } else if (pType === "function_call_output" || pType === "custom_tool_call_output") {
        tailPhase = "处理工具结果";
      } else if (pType === "agent_message" || (pType === "message" && payload.role === "assistant")) {
        tailPhase = "生成回复";
        const msgSnippet = extractResponseMessageText(payload);
        if (msgSnippet) tailText = msgSnippet.slice(-240);
      }
      continue;
    }

    if (record?.type !== "event_msg") continue;

    if (payload.type === "task_started") {
      turnId = payload.turn_id || turnId;
      status = "running";
      phase = "思考与规划";
      text = "";
      sawExplicitStarted = true;
      sawTerminal = false;
      sawActivityAfterTerminal = true;
    } else if (payload.type === "user_message") {
      turnId = "";
      status = "running";
      phase = "已收到指令";
      text = "";
      sawExplicitStarted = true;
      sawTerminal = false;
      sawActivityAfterTerminal = true;
    } else if (payload.type === "agent_reasoning") {
      status = "running";
      phase = "思考中";
      text = String(payload.text || payload.delta || "").slice(-240);
      sawExplicitStarted = true;
      sawTerminal = false;
      sawActivityAfterTerminal = true;
    } else if (payload.type === "exec_command_begin") {
      status = "running";
      phase = "执行命令";
      text = Array.isArray(payload.command) ? payload.command.join(" ") : String(payload.command || "");
      sawExplicitStarted = true;
      sawTerminal = false;
      sawActivityAfterTerminal = true;
    } else if (payload.type === "exec_command_end") {
      phase = "命令已结束";
      if (!sawTerminal) sawActivityAfterTerminal = true;
    } else if (payload.type === "agent_message") {
      phase = "生成回复";
      text = String(payload.message || "").slice(-240);
      if (!sawTerminal) sawActivityAfterTerminal = true;
    } else if (payload.type === "item_completed") {
      if (payload.turn_id) turnId = payload.turn_id;
      sawTerminal = false;
      sawActivityAfterTerminal = true;
      tailPhase = phaseFromCompletedItem(payload.item);
      if (payload.item?.command) {
        tailText = String(payload.item.command).slice(0, 180);
      }
    } else if (payload.type === "token_count") {
      if (!sawTerminal) sawActivityAfterTerminal = true;
    } else if (payload.type === "task_complete" && (!turnId || !payload.turn_id || payload.turn_id === turnId)) {
      status = "completed";
      phase = "已完成";
      sawExplicitStarted = false;
      sawTerminal = true;
      sawActivityAfterTerminal = false;
      tailPhase = "";
      tailText = "";
    } else if (payload.type === "turn_aborted" && (!turnId || !payload.turn_id || payload.turn_id === turnId)) {
      status = "interrupted";
      phase = "已中断";
      sawExplicitStarted = false;
      sawTerminal = true;
      sawActivityAfterTerminal = false;
      tailPhase = "";
      tailText = "";
    }
  }

  const fileAgeMs = mtimeMs > 0 ? Math.max(0, nowMs - mtimeMs) : 0;
  if (status === "running" && sawExplicitStarted) {
    if (mtimeMs > 0 && fileAgeMs > CODEX_STALE_RUNNING_GUARD_MS) {
      status = "idle";
      phase = "";
    } else if (!text && tailText) {
      text = tailText;
    }
  } else if (!sawTerminal && sawActivityAfterTerminal && mtimeMs > 0 && fileAgeMs <= CODEX_RUNNING_INFER_WINDOW_MS) {
    status = "running";
    phase = tailPhase || phase || "Codex 执行中";
    text = tailText || text;
  }

  return { turnId, status, phase, text, updatedAt };
}

export async function readRolloutActivitySnapshot(rolloutPath, previousCursor = null, { nowMs = Date.now() } = {}) {
  if (!rolloutPath) {
    return { cursor: "0", changed: false, activity: null };
  }
  let file;
  try {
    file = await open(rolloutPath, "r");
    const { size, mtimeMs } = await file.stat();
    const cursor = String(size);
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buf = Buffer.allocUnsafe(size - start);
    if (buf.length) await file.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const activity = summarizeRolloutActivity(lines, { mtimeMs, nowMs });
    return { cursor, changed: !previousCursor || previousCursor !== cursor, activity };
  } catch {
    return { cursor: previousCursor || "0", changed: false, activity: null };
  } finally {
    await file?.close().catch(() => {});
  }
}
