import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defaultDataDir } from "./instance-identity.mjs";

export function runtimeLeasePath(dataDir = defaultDataDir()) {
  return resolve(dataDir, "control-runtime.json");
}

export function isProcessAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export async function readRuntimeLease(dataDir = defaultDataDir()) {
  try {
    const raw = await readFile(runtimeLeasePath(dataDir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function acquireRuntimeLease({
  dataDir = defaultDataDir(),
  host = "127.0.0.1",
  port,
  instanceId = "",
  label = "",
  pid = process.pid,
} = {}) {
  const filePath = runtimeLeasePath(dataDir);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  const payload = {
    pid,
    host,
    port: Number(port),
    url: `http://${host}:${port}`,
    instanceId,
    label,
    startedAt,
  };
  const tempPath = `${filePath}.tmp-${pid}-${startedAt}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);

  return {
    filePath,
    lease: payload,
    async release() {
      const existing = await readRuntimeLease(dataDir);
      if (existing && existing.pid === pid && existing.startedAt === startedAt) {
        await unlink(filePath).catch(() => {});
      }
    },
  };
}
