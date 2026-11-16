import { open } from "node:fs/promises";

const MAX_TAIL_BYTES = 256 * 1024;

function summarizeRolloutActivity(lines) {
  let turnId = "";
  let status = "idle";
  let phase = "";
  let text = "";
  let updatedAt = 0;

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
    if (record?.type !== "event_msg") continue;

    if (payload.type === "task_started") {
      turnId = payload.turn_id || turnId;
      status = "running";
      phase = "思考与规划";
      text = "";
    } else if (payload.type === "agent_reasoning") {
      status = "running";
      phase = "思考中";
      text = String(payload.text || payload.delta || "").slice(-240);
    } else if (payload.type === "exec_command_begin") {
      status = "running";
      phase = "执行命令";
      text = Array.isArray(payload.command) ? payload.command.join(" ") : String(payload.command || "");
    } else if (payload.type === "exec_command_end") {
      phase = "命令已结束";
    } else if (payload.type === "agent_message") {
      phase = "生成回复";
      text = String(payload.message || "").slice(-240);
    } else if (payload.type === "task_complete" && (!turnId || payload.turn_id === turnId)) {
      status = "completed";
      phase = "已完成";
    } else if (payload.type === "turn_aborted" && (!turnId || payload.turn_id === turnId)) {
      status = "interrupted";
      phase = "已中断";
    }
  }
  return { turnId, status, phase, text, updatedAt };
}

export async function readRolloutActivitySnapshot(rolloutPath, previousCursor = null) {
  if (!rolloutPath) {
    return { cursor: "0", changed: false, activity: null };
  }
  let file;
  try {
    file = await open(rolloutPath, "r");
    const { size } = await file.stat();
    const cursor = String(size);
    if (previousCursor && previousCursor === cursor) {
      return { cursor, changed: false, activity: null };
    }
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buf = Buffer.allocUnsafe(size - start);
    if (buf.length) await file.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const activity = summarizeRolloutActivity(lines);
    return { cursor, changed: true, activity };
  } catch {
    return { cursor: previousCursor || "0", changed: false, activity: null };
  } finally {
    await file?.close().catch(() => {});
  }
}
