import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defaultDataDir } from "./instance-identity.mjs";

export function queuedTurnsPath(dataDir = defaultDataDir()) {
  return resolve(dataDir, "queued-turns.json");
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

export function createQueuedTurnQueue({
  deliver,
  canDeliver = () => true,
  isRetryable,
  onEvent = () => {},
  retryMs = 1_500,
  autoStart = true,
  initialEntries = [],
  filePath = "",
} = {}) {
  const queues = new Map();
  let draining = null;
  let timer = null;
  let writeChain = Promise.resolve();

  const snapshotEntries = () => [...queues.values()].flat();

  const persist = () => {
    if (!filePath) return;
    const entries = snapshotEntries();
    writeChain = writeChain
      .then(() => writeJsonAtomic(filePath, { version: 1, entries }))
      .catch(() => {});
  };

  const schedule = () => {
    if (!autoStart || timer || !queues.size) return;
    timer = setTimeout(async () => {
      timer = null;
      await drainOnce();
      schedule();
    }, retryMs);
    timer.unref?.();
  };

  const removeById = (threadId, id) => {
    const entries = queues.get(threadId) || [];
    const index = entries.findIndex((item) => item?.id === id);
    if (index < 0) return null;
    const [entry] = entries.splice(index, 1);
    if (!entries.length) queues.delete(threadId);
    if (entry) persist();
    return entry;
  };

  const drain = async () => {
    for (const [threadId, entries] of [...queues]) {
      const entry = entries[0];
      if (!entry) continue;
      if (!await canDeliver(entry)) continue;
      try {
        const result = await deliver(entry);
        removeById(threadId, entry.id);
        onEvent({ type: "started", entry, result });
      } catch (error) {
        if (isRetryable?.(error)) continue;
        removeById(threadId, entry.id);
        onEvent({ type: "failed", entry, error: { message: error?.message || String(error) } });
      }
    }
  };

  const drainOnce = async () => {
    if (draining) return draining;
    draining = drain().finally(() => { draining = null; });
    return draining;
  };

  for (const entry of initialEntries) {
    if (!entry?.id || !entry?.threadId) continue;
    const entries = queues.get(entry.threadId) || [];
    entries.push(entry);
    queues.set(entry.threadId, entries);
  }

  const api = {
    async load() {
      if (!filePath) return;
      let raw = "";
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      if (!entries.length) return;
      const seen = new Set(snapshotEntries().map((item) => item.id));
      for (const entry of entries) {
        if (!entry?.id || !entry?.threadId || seen.has(entry.id)) continue;
        seen.add(entry.id);
        const list = queues.get(entry.threadId) || [];
        list.push(entry);
        queues.set(entry.threadId, list);
      }
      schedule();
    },
    async flush() {
      await writeChain;
    },
    enqueue(threadId, input) {
      const entries = queues.get(threadId) || [];
      const entry = { id: randomUUID(), threadId, createdAt: Date.now(), ...input };
      entries.push(entry);
      queues.set(threadId, entries);
      persist();
      onEvent({ type: "queued", entry, position: entries.length });
      schedule();
      return { ...entry, position: entries.length };
    },
    list(threadId) {
      return [...(queues.get(threadId) || [])];
    },
    has(threadId) {
      return (queues.get(threadId)?.length || 0) > 0;
    },
    all() {
      return [...queues.values()].flat();
    },
    cancel(threadId, id) {
      const entry = removeById(threadId, id);
      if (!entry) return false;
      onEvent({ type: "cancelled", entry });
      return true;
    },
    drainOnce,
    close() {
      clearTimeout(timer);
      timer = null;
    },
  };
  schedule();
  return api;
}
