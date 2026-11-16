import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  extractCodexUserAttachmentsAndText,
  stripCodexPromptWrappers,
} from "../codex-input-clean.mjs";
import { isContinuationOrControlPrompt, threadTitleSourceSig } from "../thread-title.mjs";

const MAX_ROLLOUT_PROMPT_HINT_CACHE = 500;
const rolloutPromptHintCache = new Map();
const CODEX_PROMPT_HINT_TAIL_BYTES = 32 * 1024;
const AUTOMATION_CACHE_TTL_MS = 60_000;
const automationNamesCache = new Map();

function setRolloutPromptHintCache(key, value) {
  if (rolloutPromptHintCache.has(key)) {
    rolloutPromptHintCache.delete(key);
  } else if (rolloutPromptHintCache.size >= MAX_ROLLOUT_PROMPT_HINT_CACHE) {
    const oldestKey = rolloutPromptHintCache.keys().next().value;
    if (oldestKey !== undefined) rolloutPromptHintCache.delete(oldestKey);
  }
  rolloutPromptHintCache.set(key, value);
}

function isInjectedCodexUserText(text) {
  return /^(?:# AGENTS\.md instructions\b|<environment_context\b|<recommended_plugins\b|<skills_instructions\b|<permissions instructions\b|<collaboration_mode\b|<multi_agent_|<external_codex_apps_|<codex_apps_|<heartbeat\b)/i.test(
    String(text || "").trimStart(),
  );
}

function extractCodexResponseUserText(payload) {
  return (Array.isArray(payload?.content) ? payload.content : [])
    .filter((item) => ["input_text", "text"].includes(item?.type) && typeof item?.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function readCodexRolloutPromptHintsSync(rolloutPath, firstUserMessage = "") {
  const cleanFirstParam = stripCodexPromptWrappers(firstUserMessage);
  const cleanPath = String(rolloutPath || "").trim();
  if (!cleanPath) return null;
  let st;
  try {
    st = statSync(cleanPath);
    if (!st.isFile() || st.size <= 0) return null;
  } catch {
    return null;
  }

  const cached = rolloutPromptHintCache.get(cleanPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    setRolloutPromptHintCache(cleanPath, cached);
    return {
      ...cached.hints,
      firstUserText: cleanFirstParam || cached.hints.firstUserText,
    };
  }

  let raw = "";
  let offset = 0;
  try {
    if (st.size <= CODEX_PROMPT_HINT_TAIL_BYTES) {
      raw = readFileSync(cleanPath, "utf8");
    } else {
      offset = Math.max(0, st.size - CODEX_PROMPT_HINT_TAIL_BYTES);
      const len = st.size - offset;
      const fd = openSync(cleanPath, "r");
      try {
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = readSync(fd, buf, 0, len, offset);
        raw = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        closeSync(fd);
      }
      const nl = raw.indexOf("\n");
      raw = nl >= 0 ? raw.slice(nl + 1) : "";
    }
  } catch {
    return null;
  }

  let firstUserText = "";
  let lastUserText = "";
  let lastSubstantiveUserText = "";
  let prevSig = "";
  let distinctUserTurns = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload;
    let rawText = "";
    if (record?.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string") {
      rawText = payload.message.trim();
    } else if (record?.type === "event_msg" && payload?.type === "item_completed" && payload.item?.type === "UserMessage") {
      rawText = extractCodexResponseUserText(payload.item);
    } else if (record?.type === "response_item" && payload?.type === "message" && payload?.role === "user") {
      rawText = extractCodexResponseUserText(payload);
    }
    if (!rawText || isInjectedCodexUserText(rawText)) continue;

    const cleanText = stripCodexPromptWrappers(rawText);
    if (!cleanText) continue;

    const sig = threadTitleSourceSig(cleanText);
    if (!sig) continue;
    if (sig !== prevSig) {
      distinctUserTurns += 1;
      prevSig = sig;
    }
    if (offset === 0 && !firstUserText) firstUserText = cleanText;
    lastUserText = cleanText;
    if (!isContinuationOrControlPrompt(rawText) && !isContinuationOrControlPrompt(cleanText)) {
      lastSubstantiveUserText = cleanText;
    }
  }

  const effectiveLast = lastSubstantiveUserText || lastUserText;
  const firstSig = threadTitleSourceSig(cleanFirstParam || firstUserText);
  const lastSig = threadTitleSourceSig(effectiveLast);
  const hints = {
    firstUserText: cleanFirstParam || firstUserText,
    lastUserText: effectiveLast,
    hasFollowUpTurns: Boolean(
      distinctUserTurns > 1 || (firstSig && lastSig && firstSig !== lastSig),
    ),
  };

  setRolloutPromptHintCache(cleanPath, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    hints,
  });
  return hints;
}

export function indexDbPath(codexHome) {
  return resolve(codexHome, "state_5.sqlite");
}

export function queueDbPath(codexHome) {
  return resolve(codexHome, "queue_1.sqlite");
}

function parseJsonSafe(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseTimestampSeconds(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback;
}

export function normalizeCodexIndexedRow(row) {
  const source = typeof row.source === "string" && row.source.startsWith("{")
    ? parseJsonSafe(row.source)
    : row.source;
  const rawFirstUser = row.first_user_message || "";
  const rawPreview = row.preview || "";
  const rawTitle = row.title || "";
  const cleanFirstUser = stripCodexPromptWrappers(rawFirstUser);
  const cleanPreview = stripCodexPromptWrappers(rawPreview);
  const cleanTitle = stripCodexPromptWrappers(rawTitle);
  return {
    id: row.id,
    name: row.name || "",
    title: cleanTitle || row.name || "",
    firstUserMessage: rawFirstUser,
    firstUserText: cleanFirstUser,
    preview: cleanPreview || cleanFirstUser || cleanTitle || "",
    rawPreviewHint: rawPreview || rawFirstUser || rawTitle || "",
    cwd: row.cwd || "",
    createdAt: parseTimestampSeconds(row.created_at),
    updatedAt: parseTimestampSeconds(row.updated_at),
    model: row.model || "",
    reasoningEffort: row.reasoning_effort || "",
    source,
    threadSource: row.thread_source || "",
    rolloutPath: row.rollout_path || "",
    path: row.rollout_path || "",
    archived: Boolean(row.archived),
    modelProvider: row.model_provider || "openai",
    gitInfo: row.git_branch || row.git_sha || row.git_origin_url
      ? {
          branch: row.git_branch || null,
          sha: row.git_sha || null,
          originUrl: row.git_origin_url || null,
        }
      : null,
  };
}

function enrichIndexedCodexRowHints(item) {
  if (!item || item.threadSource === "subagent" || !item.rolloutPath) return false;
  const hints = readCodexRolloutPromptHintsSync(item.rolloutPath, item.firstUserMessage);
  if (hints) {
    if (hints.firstUserText && !item.firstUserText) item.firstUserText = hints.firstUserText;
    if (hints.lastUserText) item.lastUserText = hints.lastUserText;
    if (hints.hasFollowUpTurns) item.hasFollowUpTurns = true;
    if (!item.preview) item.preview = hints.firstUserText || hints.lastUserText || "";
  }
  return true;
}

const INDEXED_THREAD_COLUMNS = `
  id, rollout_path, created_at, updated_at, source, model_provider,
  cwd, title, archived, first_user_message, model, reasoning_effort,
  thread_source, preview, name, git_sha, git_branch, git_origin_url
`;

export function readIndexedThreadById(codexHome, rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;
  const dbFile = indexDbPath(codexHome);
  if (!existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT ${INDEXED_THREAD_COLUMNS}
      FROM threads
      WHERE id = ?
      LIMIT 1
    `).get(id);
    if (!row) return null;
    const item = normalizeCodexIndexedRow(row);
    enrichIndexedCodexRowHints(item);
    return item;
  } finally {
    db.close();
  }
}

export function readIndexedThreads(codexHome, {
  limit = 400,
  includeArchived = false,
} = {}) {
  const dbFile = indexDbPath(codexHome);
  if (!existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const whereClause = includeArchived ? "1=1" : "archived = 0";
    const sql = `
      SELECT ${INDEXED_THREAD_COLUMNS}
      FROM threads
      WHERE ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(Math.max(1, Number(limit) || 400));
    const normalized = rows.map(normalizeCodexIndexedRow);
    let hintProbed = 0;
    for (const item of normalized) {
      if (hintProbed >= 80) break;
      if (enrichIndexedCodexRowHints(item)) {
        hintProbed += 1;
      }
    }
    return normalized;
  } finally {
    db.close();
  }
}

function toQueueTimestampSeconds(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * Parse Codex queue_1.sqlite payload_json into readable text, model/effort, and images.
 */
export function parseCodexQueuedPayload(payloadJson) {
  const raw = typeof payloadJson === "string" ? payloadJson.trim() : "";
  if (!raw) return { text: "", images: [], model: "", effort: "", permissionMode: "" };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, images: [], model: "", effort: "", permissionMode: "" };
  }

  if (typeof parsed === "string") {
    return { text: parsed.trim(), images: [], model: "", effort: "", permissionMode: "" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { text: "", images: [], model: "", effort: "", permissionMode: "" };
  }

  const textParts = [];
  const images = [];
  const inputs = Array.isArray(parsed.input)
    ? parsed.input
    : (Array.isArray(parsed.items) ? parsed.items : []);

  for (const item of inputs) {
    if (typeof item === "string") {
      if (item.trim()) textParts.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "").toLowerCase();
    if (type === "text" || type === "input_text") {
      const value = String(item.text || item.content || "").trim();
      if (value) textParts.push(value);
    } else if (type === "image" || type === "local_image" || type === "input_image") {
      const imgPath = String(item.path || item.url || item.image_url || "").trim();
      images.push({
        name: String(item.name || (imgPath ? basename(imgPath) : "") || "图片"),
        mimeType: String(item.mimeType || item.mime_type || ""),
        path: imgPath,
      });
    }
  }

  if (!textParts.length) {
    const directText = parsed.text || parsed.prompt || parsed.message || parsed.content;
    if (typeof directText === "string" && directText.trim()) {
      textParts.push(directText.trim());
    }
  }

  if (!images.length && Array.isArray(parsed.images)) {
    for (const img of parsed.images) {
      if (typeof img === "string" && img.trim()) {
        images.push({ name: basename(img.trim()), mimeType: "", path: img.trim() });
      } else if (img && typeof img === "object") {
        const imgPath = String(img.path || img.url || "").trim();
        images.push({
          name: String(img.name || (imgPath ? basename(imgPath) : "") || "图片"),
          mimeType: String(img.mimeType || img.mime_type || ""),
          path: imgPath,
        });
      }
    }
  }

  const rawText = textParts.join("\n").trim();
  const extracted = extractCodexUserAttachmentsAndText(rawText, {
    preserveQuestionReplies: true,
    truncatedPreview: false,
  });
  const seenImgPaths = new Set(images.map((img) => img.path).filter(Boolean));
  for (const extraImg of extracted.images) {
    if (extraImg.path && seenImgPaths.has(extraImg.path)) continue;
    if (extraImg.path) seenImgPaths.add(extraImg.path);
    images.push({
      name: extraImg.name || (extraImg.path ? basename(extraImg.path) : "图片"),
      mimeType: "",
      path: extraImg.path || "",
    });
  }

  return {
    text: extracted.text,
    images,
    model: String(parsed.model || "").trim(),
    effort: String(parsed.reasoningEffort || parsed.effort || "").trim(),
    permissionMode: String(parsed.permissionMode || parsed.approvalPolicy || "").trim(),
  };
}

export function readCodexQueuedItems(codexHome, rawId) {
  const cleanId = String(rawId || "").trim();
  const dbFile = queueDbPath(codexHome);
  if (!cleanId || !existsSync(dbFile)) return [];
  let db = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare(`
      SELECT id, thread_id, payload_json, queue_order, created_at_ms, updated_at_ms
      FROM queued_items
      WHERE thread_id = ?
      ORDER BY queue_order ASC, created_at_ms ASC, id ASC
    `).all(cleanId);
    return rows.map((row, index) => {
      const parsed = parseCodexQueuedPayload(row.payload_json);
      return {
        id: String(row.id),
        createdAt: toQueueTimestampSeconds(row.created_at_ms || row.updated_at_ms),
        text: parsed.text,
        model: parsed.model,
        effort: parsed.effort,
        permissionMode: parsed.permissionMode,
        goalMode: false,
        imageCount: parsed.images.length,
        images: parsed.images,
        source: "codex-native",
        sourceLabel: "Codex 队列",
        canCancel: false,
        position: index + 1,
      };
    });
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

export function readCodexQueuedCountsByThread(codexHome) {
  const counts = new Map();
  const dbFile = queueDbPath(codexHome);
  if (!existsSync(dbFile)) return counts;
  let db = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare(`
      SELECT thread_id, COUNT(*) AS cnt
      FROM queued_items
      GROUP BY thread_id
    `).all();
    for (const row of rows) {
      const id = String(row?.thread_id || "").trim();
      const cnt = Number(row?.cnt) || 0;
      if (id && cnt > 0) counts.set(id, cnt);
    }
    return counts;
  } catch {
    return new Map();
  } finally {
    try { db?.close(); } catch {}
  }
}

function parseTomlStringValue(raw = "") {
  const m = String(raw || "").match(/^\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const s = String(raw || "").match(/^\s*'([^']*)'/);
  return s ? s[1] : "";
}

/**
 * Read read-only automation id -> human name mappings from <codexHome>/automations/<id>/automation.toml.
 */
export function readCodexAutomationNames(codexHome) {
  const home = String(codexHome || "").trim();
  if (!home) return new Map();
  const cached = automationNamesCache.get(home);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.names;
  }

  const names = new Map();
  const autoRoot = resolve(home, "automations");
  try {
    if (existsSync(autoRoot)) {
      for (const entry of readdirSync(autoRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const tomlPath = resolve(autoRoot, entry.name, "automation.toml");
        try {
          const st = statSync(tomlPath);
          if (!st.isFile() || st.size <= 0 || st.size > 32 * 1024) continue;
          const content = readFileSync(tomlPath, "utf8");
          let idVal = "";
          let nameVal = "";
          for (const line of content.split(/\r?\n/)) {
            const idMatch = line.match(/^\s*id\s*=\s*(.+)$/);
            if (idMatch && !idVal) idVal = parseTomlStringValue(idMatch[1]);
            const nameMatch = line.match(/^\s*name\s*=\s*(.+)$/);
            if (nameMatch && !nameVal) nameVal = parseTomlStringValue(nameMatch[1]);
            if (idVal && nameVal) break;
          }
          const finalId = idVal || entry.name;
          if (finalId && nameVal) {
            names.set(finalId, nameVal);
          }
        } catch {
          // Skip unreadable automation manifests.
        }
      }
    }
  } catch {
    // Ignore missing automations directory.
  }

  automationNamesCache.set(home, {
    names,
    expiresAt: Date.now() + AUTOMATION_CACHE_TTL_MS,
  });
  return names;
}
