import { escapeHtml } from "./markdown.js";
import { providerDisplayName } from "./instance-switcher.js";

function decisionLabel(decision) {
  switch (decision) {
    case "accept":
    case "approved":
      return "允许一次";
    case "acceptForSession":
    case "approved_for_session":
      return "本会话允许";
    case "decline":
    case "denied":
      return "拒绝";
    case "cancel":
    case "abort":
      return "终止";
    default:
      return decision;
  }
}

export function renderServerRequestCard(request, { agentLabel = "" } = {}) {
  const resolvedLabel = agentLabel || providerDisplayName(request.provider);
  const id = escapeHtml(request.id);

  if (request.kind === "userInput") {
    const questions = Array.isArray(request.questions) ? request.questions : [];
    const qHtml = questions.map((q, qIdx) => {
      const qId = escapeHtml(q.id || `q_${qIdx}`);
      const options = Array.isArray(q.options) ? q.options : [];
      const inputType = q.multiSelect ? "checkbox" : "radio";
      const optsHtml = options.map((opt, oIdx) => {
        const val = escapeHtml(opt.label || opt);
        const desc = opt.description ? `<span class="sr-opt-desc">${escapeHtml(opt.description)}</span>` : "";
        return `
          <label class="sr-option">
            <input type="${inputType}" name="q-${qId}" value="${val}" ${!q.multiSelect && oIdx === 0 ? "checked" : ""} />
            <span class="sr-opt-main">
              <strong>${val}</strong>
              ${desc}
            </span>
          </label>
        `;
      }).join("");

      return `
        <div class="sr-question" data-question-id="${qId}" data-multi="${q.multiSelect ? "1" : "0"}">
          <div class="sr-q-header">${escapeHtml(q.header || `问题 ${qIdx + 1}`)}</div>
          <div class="sr-q-prompt">${escapeHtml(q.question || "")}</div>
          ${optsHtml ? `<div class="sr-options">${optsHtml}</div>` : ""}
          ${q.isOther !== false ? `<input class="sr-other-input" type="text" data-other-for="${qId}" placeholder="其他补充说明（可选）" />` : ""}
        </div>
      `;
    }).join("");

    return `
      <form class="server-request-card" data-request-id="${id}" data-kind="userInput">
        <div class="sr-head">
          <span class="sr-badge">${escapeHtml(resolvedLabel)}</span>
          <strong>${escapeHtml(request.title || `${resolvedLabel} 需要你的回答`)}</strong>
        </div>
        <div class="sr-questions">${qHtml}</div>
        <div class="sr-actions">
          <button type="submit" class="btn-primary">提交回答</button>
          <button type="button" class="btn-secondary" data-decline-id="${id}">取消</button>
        </div>
      </form>
    `;
  }

  if (request.kind === "acpPermission" && Array.isArray(request.options) && request.options.length) {
    const optButtons = request.options.map((opt) => {
      const optId = escapeHtml(opt.optionId || opt.id || "");
      const isDeny = String(opt.kind || "").includes("reject");
      return `<button type="button" class="${isDeny ? "btn-danger" : "btn-primary"}" data-request-id="${id}" data-option-id="${optId}">${escapeHtml(opt.name || optId)}</button>`;
    }).join("");
    return `
      <div class="server-request-card" data-request-id="${id}" data-kind="acpPermission">
        <div class="sr-head">
          <span class="sr-badge">${escapeHtml(resolvedLabel)}</span>
          <strong>${escapeHtml(request.title || `${resolvedLabel} 请求授权`)}</strong>
        </div>
        ${request.command ? `<pre class="sr-code">${escapeHtml(request.command)}</pre>` : ""}
        ${request.reason ? `<p class="sr-reason">${escapeHtml(request.reason)}</p>` : ""}
        <div class="sr-actions">${optButtons}</div>
      </div>
    `;
  }

  const decisions = Array.isArray(request.availableDecisions) && request.availableDecisions.length
    ? request.availableDecisions
    : ["accept", "acceptForSession", "decline"];

  const details = [];
  if (request.command) details.push(`<pre class="sr-code">${escapeHtml(request.command)}</pre>`);
  if (request.filePath) details.push(`<div class="sr-meta">目标文件：<code>${escapeHtml(request.filePath)}</code></div>`);
  if (request.cwd) details.push(`<div class="sr-meta">目录：<code>${escapeHtml(request.cwd)}</code></div>`);
  if (request.reason) details.push(`<p class="sr-reason">${escapeHtml(request.reason)}</p>`);

  return `
    <div class="server-request-card" data-request-id="${id}" data-kind="${escapeHtml(request.kind || "approval")}">
      <div class="sr-head">
        <span class="sr-badge">${escapeHtml(resolvedLabel)}</span>
        <strong>${escapeHtml(request.title || `${resolvedLabel} 请求授权`)}</strong>
      </div>
      ${details.join("")}
      <div class="sr-actions">
        ${decisions.map((d) => {
          const cls = (d === "decline" || d === "denied" || d === "cancel" || d === "abort")
            ? "btn-danger"
            : (d === "acceptForSession" || d === "approved_for_session" ? "btn-secondary" : "btn-primary");
          return `<button type="button" class="${cls}" data-request-id="${id}" data-decision="${escapeHtml(d)}">${escapeHtml(decisionLabel(d))}</button>`;
        }).join("")}
      </div>
    </div>
  `;
}

export function collectUserInputAnswers(request, formElement) {
  const answers = {};
  for (const q of request?.questions || []) {
    const qId = String(q.id || "");
    const inputs = [...formElement.querySelectorAll(`input[name="q-${CSS?.escape ? CSS.escape(qId) : qId}"]:checked`)];
    const selected = inputs.map((el) => el.value).filter(Boolean);
    const otherInput = formElement.querySelector(`input[data-other-for="${CSS?.escape ? CSS.escape(qId) : qId}"]`);
    const otherValue = String(otherInput?.value || "").trim();
    if (otherValue) selected.push(otherValue);
    answers[qId] = { answers: selected };
  }
  return answers;
}
