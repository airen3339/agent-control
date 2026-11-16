import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import {
  defaultPlatformHostLabel,
  resolvePlatformDataDir,
} from "./platform.mjs";

export function defaultDataDir(env = process.env, home = os.homedir()) {
  const custom = String(env?.AGENT_CONTROL_DATA_DIR || "").trim();
  return resolvePlatformDataDir({
    customDir: custom,
    env,
    homeDir: home,
  });
}

export function instanceIdentityPath(dataDir = defaultDataDir()) {
  return resolve(dataDir, "instance.json");
}

function defaultHostLabel(hostname = os.hostname()) {
  return defaultPlatformHostLabel(hostname);
}

async function writeAtomicJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

export async function ensureInstanceIdentity({
  dataDir = defaultDataDir(),
  hostname = os.hostname(),
  label = "",
} = {}) {
  const filePath = instanceIdentityPath(dataDir);
  let current = null;
  try {
    current = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    current = null;
  }
  const desiredLabel = String(label || current?.label || defaultHostLabel(hostname)).trim() || defaultHostLabel(hostname);
  if (current?.instanceId && current.label === desiredLabel) {
    return {
      instanceId: String(current.instanceId),
      label: String(current.label),
      createdAt: Number(current.createdAt) || Date.now(),
    };
  }
  const next = {
    instanceId: String(current?.instanceId || randomBytes(6).toString("hex")),
    label: desiredLabel,
    createdAt: Number(current?.createdAt) || Date.now(),
  };
  await writeAtomicJson(filePath, next);
  return next;
}
