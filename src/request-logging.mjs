export function logRequestError(context, error, {
  now = Date.now,
  write = (line) => process.stderr.write(line),
} = {}) {
  const finishedAt = now();
  const entry = {
    timestamp: new Date(finishedAt).toISOString(),
    level: "error",
    event: "request_failed",
    requestId: context.requestId,
    method: context.method,
    path: context.path,
    threadId: context.threadId || null,
    provider: context.provider || null,
    profileId: context.profileId || null,
    status: Number(error?.status) || 500,
    durationMs: Math.max(0, finishedAt - context.startedAt),
    error: {
      name: error?.name || "Error",
      code: error?.code || null,
      message: error?.message || "Agent Control 请求失败",
      stack: error?.stack || null,
    },
  };
  write(`${JSON.stringify(entry)}\n`);
  return entry;
}
