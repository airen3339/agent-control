export const VOICE_CALL_WORKSPACE_MARKER = "voice-call";

export function isInternalVoiceCallThread(threadOrCwd) {
  if (!threadOrCwd) return false;
  if (typeof threadOrCwd === "string") {
    const norm = threadOrCwd.replace(/\\/g, "/").replace(/\/+$/, "");
    return norm.endsWith(`/${VOICE_CALL_WORKSPACE_MARKER}`)
      || norm.includes(`/${VOICE_CALL_WORKSPACE_MARKER}/`);
  }
  const cwd = String(threadOrCwd.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (cwd && (cwd.endsWith(`/${VOICE_CALL_WORKSPACE_MARKER}`) || cwd.includes(`/${VOICE_CALL_WORKSPACE_MARKER}/`))) {
    return true;
  }
  const title = String(threadOrCwd.title || threadOrCwd.name || "");
  const preview = String(threadOrCwd.preview || "");
  return title.includes("[AC_VOICE_CALL]") || preview.includes("[AC_VOICE_CALL]");
}

export function isInternalSubagentThread(thread) {
  if (isInternalVoiceCallThread(thread)) return true;
  if (String(thread?.threadSource || "").toLowerCase() === "subagent") return true;
  const source = thread?.source;
  if (!source || typeof source !== "object") return false;
  return Object.keys(source).some((key) => key.toLowerCase().startsWith("subagent"));
}

export function visibleControlThreads(threads = []) {
  return threads.filter((thread) => !isInternalSubagentThread(thread));
}

export async function requireDirectlyControllableThread(threadId, { knownThread, readThread }) {
  const thread = knownThread || await readThread(threadId);
  if (isInternalSubagentThread(thread)) {
    const error = new Error("这是父任务内部的子代理会话，不能单独继续；请返回父会话发送消息");
    error.status = 409;
    error.code = "thread_not_directly_controllable";
    throw error;
  }
  return thread;
}
