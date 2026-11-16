import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defaultDataDir } from "./instance-identity.mjs";
import { isRecoverableToolExecutionError } from "./tool-errors.mjs";

export const GOAL_COMPLETE_MARKER = "<!-- GOAL_COMPLETE -->";
export const DEFAULT_MAX_GOAL_TURNS = 20;

export function goalStatePath(dataDir = defaultDataDir()) {
  return resolve(dataDir, "goal-states.json");
}

export function goalContinuationPrompt({ turnCount = 1, maxTurns = DEFAULT_MAX_GOAL_TURNS } = {}) {
  return [
    `[Goal 自动推进 · 第 ${turnCount}/${maxTurns} 轮核查]`,
    "请核对当前任务的所有要求与验收条件：",
    `1. 如果已经全部完成且通过真实运行或检查验证，请在回复末尾单独另起一行输出 ${GOAL_COMPLETE_MARKER}；`,
    "2. 如果仍有未完成、失败或未验证的部分，请不要输出完成标记，直接继续执行并给出进展。",
  ].join("\n");
}

export function hasGoalCompleteMarker(text) {
  return String(text || "").includes(GOAL_COMPLETE_MARKER);
}

export function createGoalController({
  filePath = goalStatePath(),
  defaultMaxTurns = DEFAULT_MAX_GOAL_TURNS,
} = {}) {
  const states = new Map();
  let loaded = false;
  let writeChain = Promise.resolve();

  const ensureLoaded = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.states && typeof parsed.states === "object") {
        for (const [id, value] of Object.entries(parsed.states)) {
          if (value && typeof value === "object") states.set(id, value);
        }
      }
    } catch {
      // Ignore missing or corrupt state file.
    }
  };

  const persist = async () => {
    const payload = JSON.stringify({
      version: 1,
      states: Object.fromEntries(states),
    }, null, 2);
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tempPath, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, filePath);
    });
    return writeChain;
  };

  const snapshot = (entry) => (entry ? { ...entry } : null);

  return {
    filePath,
    async load() {
      await ensureLoaded();
      return Object.fromEntries([...states.entries()].map(([k, v]) => [k, { ...v }]));
    },
    get(compositeId) {
      return snapshot(states.get(compositeId));
    },
    async arm(compositeId, {
      backend = "orchestrator",
      maxTurns = defaultMaxTurns,
      model = "",
      effort = "",
      permissionMode = "workspace",
      goalPrompt = "",
    } = {}) {
      await ensureLoaded();
      const prev = states.get(compositeId);
      const next = {
        enabled: true,
        active: true,
        status: "armed",
        backend,
        turnCount: 1,
        maxTurns: Math.max(1, Math.min(50, Number(maxTurns) || defaultMaxTurns)),
        model: model || prev?.model || "",
        effort: effort || prev?.effort || "",
        permissionMode: permissionMode || prev?.permissionMode || "workspace",
        goalPrompt: String(goalPrompt || prev?.goalPrompt || "").slice(0, 4000),
        startedAt: Date.now(),
        completedAt: null,
        stopReason: null,
        updatedAt: Date.now(),
      };
      states.set(compositeId, next);
      await persist();
      return snapshot(next);
    },
    async disarm(compositeId, { status = "stopped", stopReason = "manual" } = {}) {
      await ensureLoaded();
      const prev = states.get(compositeId);
      if (!prev) return null;
      const next = {
        ...prev,
        enabled: false,
        active: false,
        status,
        stopReason,
        completedAt: status === "completed" ? Date.now() : prev.completedAt,
        updatedAt: Date.now(),
      };
      states.set(compositeId, next);
      await persist();
      return snapshot(next);
    },
    async syncExternal(compositeId, externalState) {
      await ensureLoaded();
      if (!externalState) return null;
      const prev = states.get(compositeId) || {};
      const next = {
        ...prev,
        ...externalState,
        backend: externalState.backend || "native",
        updatedAt: Date.now(),
      };
      states.set(compositeId, next);
      await persist();
      return snapshot(next);
    },
    async evaluateAfterTurn(compositeId, {
      lastAgentMessage = "",
      interrupted = false,
      error = null,
    } = {}) {
      await ensureLoaded();
      const current = states.get(compositeId);
      if (!current?.enabled || !current?.active || current.backend === "native") {
        return { action: "none", state: snapshot(current) };
      }
      if (interrupted) {
        const state = await this.disarm(compositeId, { status: "stopped", stopReason: "interrupted" });
        return { action: "stopped", state };
      }
      if (error && !isRecoverableToolExecutionError(error)) {
        const state = await this.disarm(compositeId, { status: "stopped", stopReason: "error" });
        return { action: "stopped", state };
      }
      if (hasGoalCompleteMarker(lastAgentMessage)) {
        const state = await this.disarm(compositeId, { status: "completed", stopReason: "marker" });
        return { action: "completed", state };
      }
      const nextTurnCount = (Number(current.turnCount) || 1) + 1;
      if (nextTurnCount > current.maxTurns) {
        const state = await this.disarm(compositeId, { status: "stopped", stopReason: "max_turns" });
        return { action: "stopped", state };
      }
      const next = {
        ...current,
        status: "continuing",
        turnCount: nextTurnCount,
        updatedAt: Date.now(),
      };
      states.set(compositeId, next);
      await persist();
      return {
        action: "continue",
        prompt: goalContinuationPrompt({ turnCount: nextTurnCount, maxTurns: current.maxTurns }),
        state: snapshot(next),
      };
    },
    flush() {
      return writeChain;
    },
  };
}
