const STEP_ECHO_HEADER_RE = /^(?:(?:Created At|Completed At):[^\n]*(?:\n|$))+/i;
const STEP_EXEC_PREFIX_RE = /^Encountered error in (?:step|tool) execution:\s*/i;

const FILE_NOT_FOUND_RE = /\bfile does not exist\b|\bno such file or directory\b|\bENOENT\b|\bpath does not exist\b/i;
const SPAWN_ERROR_RE = /\bspawn(?:\s+[^\n]+)?\s+ENOENT\b/i;
const INVALID_LINE_RANGE_RE = /\binvalid line range\b|StartLine\s+\d+\s+is greater than EndLine\s+\d+/i;
const START_END_LINE_RE = /StartLine\s+(\d+)\s+is greater than EndLine\s+(\d+)/i;
const TARGET_NOT_FOUND_RE = /target content not found in the file|Target must exactly match existing file text/i;
const IS_DIR_RE = /\bis a directory\b|\bEISDIR\b/i;
const ALREADY_FORMATTED_RE = /^(?:文件不存在|行号范围无效|补丁内容未匹配|目标是目录而非文件|单步工具未通过)/;

function unwrapQuotedPath(value) {
  let text = String(value ?? "").trim();
  for (let i = 0; i < 2; i += 1) {
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "string") {
          text = parsed.trim();
          continue;
        }
      } catch {
        text = text.slice(1, -1).trim();
        continue;
      }
    }
    break;
  }
  return text.replace(/^file:\/\//i, "").trim();
}

/**
 * 剥离 Antigravity step 回显中的 Created At / Completed At 头部及英文执行错误前缀。
 */
export function stripStepEchoPrefix(rawText = "") {
  return String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(STEP_ECHO_HEADER_RE, "")
    .trim()
    .replace(STEP_EXEC_PREFIX_RE, "")
    .replace(STEP_ECHO_HEADER_RE, "")
    .trim();
}

/**
 * 判断错误是否为可恢复的单步工具执行失败（不应导致整轮任务失败或中断 /goal）。
 */
export function isRecoverableToolExecutionError(errorOrText) {
  if (!errorOrText) return false;
  if (typeof errorOrText === "object") {
    if (errorOrText.recoverable === true) return true;
    if (String(errorOrText.syscall || "").startsWith("spawn")) return false;
  }
  const text = typeof errorOrText === "string"
    ? errorOrText
    : String(errorOrText?.message || errorOrText?.error?.message || "");
  const clean = text.trim();
  if (!clean) return false;
  if (SPAWN_ERROR_RE.test(clean)) return false;
  return (
    /Encountered error in (?:step|tool) execution:/i.test(clean)
    || FILE_NOT_FOUND_RE.test(clean)
    || INVALID_LINE_RANGE_RE.test(clean)
    || TARGET_NOT_FOUND_RE.test(clean)
    || IS_DIR_RE.test(clean)
  );
}

/**
 * 从工具调用参数或文件改动项中提取目标文件路径。
 */
export function extractToolTargetPath(toolName = "", args = {}, changes = []) {
  const firstChangePath = Array.isArray(changes) ? changes[0]?.path : "";
  const safeArgs = args && typeof args === "object" ? args : {};
  const rawCandidate = firstChangePath
    || safeArgs.Path
    || safeArgs.path
    || safeArgs.TargetFile
    || safeArgs.AbsolutePath
    || safeArgs.DirectoryPath
    || safeArgs.File
    || safeArgs.file_path
    || "";
  return unwrapQuotedPath(rawCandidate);
}

/**
 * 提取路径末尾的文件名用于界面精简展示。
 */
export function shortFileNameFromPath(rawPath = "") {
  const clean = unwrapQuotedPath(rawPath);
  if (!clean) return "";
  const parts = clean.split(/[/\\]+/).filter((seg) => seg && seg !== "." && seg !== "..");
  return parts.length ? parts[parts.length - 1] : clean;
}

function extractFallbackFileLabel(reason = "") {
  const pathMatch = String(reason || "").match(/(?:file:\/\/)?(?:\/[^\s"'`:;,)]+|(?:[\w.-]+[/\\])+[\w.-]+\.[A-Za-z0-9_-]+)/);
  if (pathMatch?.[0]) return shortFileNameFromPath(pathMatch[0]);
  return "";
}

/**
 * 将原始英文工具错误格式化为可读中文，并尽量附带目标文件名。
 */
export function formatToolExecutionError(rawText = "", { filePath = "", toolName = "" } = {}) {
  const reason = stripStepEchoPrefix(rawText);
  const explicitLabel = shortFileNameFromPath(filePath);
  const fileLabel = explicitLabel || extractFallbackFileLabel(reason);

  if (!reason) {
    const fallbackTool = String(toolName || "").trim();
    if (fileLabel) return `单步工具未通过：${fileLabel}`;
    return fallbackTool ? `单步工具未通过（${fallbackTool}）` : "单步工具未通过";
  }

  if (ALREADY_FORMATTED_RE.test(reason)) {
    if (explicitLabel && !reason.includes(explicitLabel)) {
      if (reason === "文件不存在" || reason === "补丁内容未匹配" || reason === "目标是目录而非文件" || /^行号范围无效/.test(reason)) {
        return `${reason}：${explicitLabel}`;
      }
    }
    return reason;
  }

  if (FILE_NOT_FOUND_RE.test(reason)) {
    return fileLabel ? `文件不存在：${fileLabel}` : "文件不存在";
  }

  if (INVALID_LINE_RANGE_RE.test(reason)) {
    const rangeMatch = reason.match(START_END_LINE_RE);
    const prefix = rangeMatch
      ? `行号范围无效（第 ${rangeMatch[1]}–${rangeMatch[2]} 行）`
      : "行号范围无效";
    return fileLabel ? `${prefix}：${fileLabel}` : prefix;
  }

  if (TARGET_NOT_FOUND_RE.test(reason)) {
    return fileLabel ? `补丁内容未匹配：${fileLabel}` : "补丁内容未匹配";
  }

  if (IS_DIR_RE.test(reason)) {
    return fileLabel ? `目标是目录而非文件：${fileLabel}` : "目标是目录而非文件";
  }

  return fileLabel ? `单步工具未通过（${fileLabel}）：${reason}` : `单步工具未通过：${reason}`;
}
