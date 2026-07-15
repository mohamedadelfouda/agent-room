import {
  connectorActionKeys,
  connectorLabelKey,
  connectorStatusKey,
  decisionActionKey,
  decisionOutcomeKey,
  decisionTypeKey,
  errorMessageKey,
  formatLocaleDuration,
  formatMessageCount,
  formatLocaleNumber,
  localeId,
} from "./i18n-core.js";
import { createLatestRequest } from "./latest-request.js";
import { activityControls } from "./activity-state.js";
import { closeReservedPrWindow, openReservedPrWindow, reservePrWindow } from "./pr-window.js";
import { STRINGS } from "./strings.js";

const $ = (id) => document.getElementById(id);

let currentSessionId = null;
let currentSession = null;
let sessionViewEpoch = 0;
const sessionRequests = createLatestRequest((id) => api(`/api/sessions/${id}`));
const connectorRequests = createLatestRequest(async (id) => {
  const [data, configuration] = await Promise.all([
    api(`/api/sessions/${id}/connectors`),
    api("/api/connector-config"),
  ]);
  return { data, configuration };
});
let eventSource = null;
let mode = "collaboration";
let running = false;
let lang = "ar";
let routeSuggestion = null;

function isCurrentSessionView(sessionId, viewEpoch) {
  return currentSessionId === sessionId && sessionViewEpoch === viewEpoch;
}
let providers = [];
let renderedMessageSessionId = null;
let renderedMessageIds = new Set();

const settingsIds = () => ["rounds", "finalizer", ...providers.flatMap((item) => ["Command", "Model", "Effort", "Role", "Enabled"].map((suffix) => `${item.id}${suffix}`))];
const providerInfo = (id) => providers.find((item) => item.id === id) || { id, label: id || "Agent" };

/* ---------------- i18n ---------------- */
const t = (key) => STRINGS[lang][key];

function bdi(value, direction = "auto") {
  return `<bdi dir="${direction}">${esc(value)}</bdi>`;
}

function failureDetail(failure) {
  return String(failure?.detail || failure?.error || failure?.warning || failure?.message || "");
}

function localizedFailure(failure) {
  const key = errorMessageKey(failure);
  const detail = failureDetail(failure);
  if (detail) console.error(`[Agent Room: ${failure?.code || failure?.reasonCode || "unexpected"}] ${detail}`);
  return t(key) || t("errorUnexpected");
}

function failureFromPayload(payload) {
  return Object.assign(new Error(failureDetail(payload)), payload);
}

function localizedMarkup(key, fallback) {
  return key ? esc(t(key)) : bdi(fallback, "ltr");
}

function effortMessageKey(value) {
  return {
    minimal: "effortMinimal",
    low: "effortLow",
    medium: "effortMedium",
    high: "effortHigh",
    xhigh: "effortXhigh",
    max: "effortMax",
    ultracode: "effortUltracode",
  }[value] || null;
}

function rolePresetForValue(value) {
  for (const language of Object.keys(STRINGS)) {
    for (const key of ["defaultRole", "debateAdvocateRole", "debateChallengerRole"]) {
      if (STRINGS[language][key] === value) return key;
    }
  }
  return null;
}

function applyRolePreset(input, presetKey) {
  if (!input || input.dataset.roleEdited === "true") return;
  input.dataset.rolePreset = presetKey;
  input.value = t(presetKey);
}

function localizeProviderRoles() {
  providers.forEach((item) => {
    const input = $(`${item.id}Role`);
    if (input) applyRolePreset(input, input.dataset.rolePreset || "defaultRole");
  });
}

function applyLang(next) {
  lang = STRINGS[next] ? next : "ar";
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach((el) => { const k = el.getAttribute("data-i18n"); if (STRINGS[lang][k]) el.textContent = t(k); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { const k = el.getAttribute("data-i18n-ph"); if (STRINGS[lang][k]) el.placeholder = t(k); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { const k = el.getAttribute("data-i18n-title"); if (STRINGS[lang][k]) el.title = t(k); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    const value = STRINGS[lang][el.getAttribute("data-i18n-aria-label")];
    if (typeof value === "string") el.setAttribute("aria-label", value);
  });
  document.querySelectorAll("[data-provider-toggle]").forEach((input) => input.setAttribute("aria-label", t("providerEnabled")(providerInfo(input.dataset.providerToggle).label)));
  document.querySelectorAll(".check-cli").forEach((button) => button.setAttribute("aria-label", t("checkProvider")(providerInfo(button.dataset.agent).label)));
  document.querySelectorAll(".setup-cli").forEach((button) => button.setAttribute("aria-label", t("setupProviderCli")(providerInfo(button.dataset.agent).label)));
  document.querySelectorAll(".load-models").forEach((button) => button.setAttribute("aria-label", t("loadProviderModels")(providerInfo(button.dataset.agent).label)));
  document.querySelectorAll("[data-effort-value]").forEach((option) => {
    const key = effortMessageKey(option.dataset.effortValue);
    option.textContent = key ? t(key) : option.dataset.effortValue;
    option.dir = key ? "auto" : "ltr";
  });
  localizeProviderRoles();
  document.querySelectorAll(".lang-btn").forEach((b) => {
    const active = b.dataset.lang === lang;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  setConnected(!$("serverStatus").classList.contains("is-bad") ? true : false);
  updateSetupSummary();
  refreshSessions();
  if (currentSession) { loadSessionMeta(); renderMessages(); loadConnectors(); }
  localStorage.setItem("agent-room-lang", lang);
}

/* ---------------- settings ---------------- */
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("agent-room-settings") || "{}");
    for (const id of settingsIds()) {
      const el = $(id); if (!el || !(id in saved)) continue;
      if (el.type === "checkbox") el.checked = Boolean(saved[id]); else el.value = saved[id];
      if (id.endsWith("Role")) {
        const preset = rolePresetForValue(el.value);
        el.dataset.roleEdited = String(!preset);
        if (preset) el.dataset.rolePreset = preset;
      }
    }
    if (saved.mode) setMode(saved.mode, true);
  } catch {}
}
function saveSettings() {
  const saved = { mode };
  for (const id of settingsIds()) { const el = $(id); if (!el) continue; saved[id] = el.type === "checkbox" ? el.checked : el.value; }
  localStorage.setItem("agent-room-settings", JSON.stringify(saved));
}

/* ---------------- api ---------------- */
async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json; charset=utf-8", ...(options.headers || {}) }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    Object.assign(error, data);
    throw error;
  }
  return data;
}

/* ---------------- managed modal focus ---------------- */
const FOCUSABLE_SELECTOR = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";
let activeModal = null;
let activeModalDismiss = null;
let modalReturnFocus = null;

function focusableElements(modal) {
  return [...modal.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => element.getClientRects().length > 0);
}

function openManagedModal(modal, { initialFocus, dismiss }) {
  if (activeModal && activeModal !== modal) closeManagedModal(activeModal, { restoreFocus: false });
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  activeModal = modal;
  activeModalDismiss = dismiss;
  $("appShell").inert = true;
  modal.classList.remove("hidden");
  requestAnimationFrame(() => {
    const target = initialFocus || focusableElements(modal)[0] || modal.querySelector(".modal");
    target?.focus();
  });
}

function closeManagedModal(modal, { restoreFocus = true } = {}) {
  modal.classList.add("hidden");
  if (activeModal !== modal) return;
  const returnFocus = modalReturnFocus;
  activeModal = null;
  activeModalDismiss = null;
  modalReturnFocus = null;
  $("appShell").inert = false;
  if (restoreFocus && returnFocus?.isConnected) requestAnimationFrame(() => returnFocus.focus());
}

document.addEventListener("keydown", (event) => {
  if (!activeModal) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    activeModalDismiss?.();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableElements(activeModal);
  if (!focusable.length) {
    event.preventDefault();
    activeModal.querySelector(".modal")?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const currentIndex = focusable.indexOf(document.activeElement);
  if (currentIndex === -1 || (event.shiftKey && document.activeElement === first)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}, true);

async function loadProviderCatalog() {
  const response = await api("/api/providers");
  providers = response.providers || [];
  const grid = $("agentsGrid");
  grid.innerHTML = "";
  for (const item of providers) {
    const card = document.createElement("article");
    card.className = "agent-card";
    card.dataset.agent = item.id;
    const modelList = `${item.id}Models`;
    const titleId = `${item.id}Title`;
    const enabledId = `${item.id}Enabled`;
    const commandId = `${item.id}Command`;
    const modelId = `${item.id}Model`;
    const effortId = `${item.id}Effort`;
    const roleId = `${item.id}Role`;
    const modelOptions = (item.models || []).map((model) => `<option value="${esc(model)}"></option>`).join("");
    const effortOptions = (item.efforts || []).map((effort) => {
      const key = effortMessageKey(effort);
      return `<option value="${esc(effort)}" data-effort-value="${esc(effort)}" dir="${key ? "auto" : "ltr"}"${effort === "high" ? " selected" : ""}>${esc(key ? t(key) : effort)}</option>`;
    }).join("");
    card.setAttribute("aria-labelledby", titleId);
    card.innerHTML = [
      `<div class="agent-head"><span class="agent-avatar ${esc(item.id)}" aria-hidden="true">${esc(item.label.slice(0, 1))}</span>`,
      `<div class="agent-id"><h3 id="${esc(titleId)}">${esc(item.label)}</h3><span id="${esc(item.id)}Health" class="health" role="status" aria-live="polite" data-i18n="notChecked">${esc(t("notChecked"))}</span></div>`,
      `<label class="switch" for="${esc(enabledId)}"><input id="${esc(enabledId)}" type="checkbox" checked data-provider-toggle="${esc(item.id)}" aria-label="${esc(t("providerEnabled")(item.label))}"><span aria-hidden="true"></span></label></div>`,
      `<div class="agent-fields"><div class="field"><label for="${esc(commandId)}" data-i18n="command">${esc(t("command"))}</label><div class="inline"><input id="${esc(commandId)}" value="${esc(item.command)}"><button class="btn-mini check-cli" data-agent="${esc(item.id)}" data-i18n="check" aria-label="${esc(t("checkProvider")(item.label))}">${esc(t("check"))}</button><button class="btn-mini setup-cli" data-agent="${esc(item.id)}" data-i18n="setupCli" aria-label="${esc(t("setupProviderCli")(item.label))}" aria-expanded="false" aria-controls="${esc(item.id)}CliSetup">${esc(t("setupCli"))}</button></div></div>`,
      `<div class="field"><label for="${esc(modelId)}" data-i18n="model">${esc(t("model"))}</label><div class="inline"><input id="${esc(modelId)}" list="${esc(modelList)}" value="${esc(item.defaultModel || "")}">${item.dynamicModels ? `<button class="btn-mini load-models" data-agent="${esc(item.id)}" data-i18n="load" aria-label="${esc(t("loadProviderModels")(item.label))}">${esc(t("load"))}</button>` : ""}</div><datalist id="${esc(modelList)}">${modelOptions}</datalist></div>`,
      `<div class="field"><label for="${esc(effortId)}" data-i18n="effort">${esc(t("effort"))}</label><select id="${esc(effortId)}">${effortOptions}</select></div>`,
      `<div class="field"><label for="${esc(roleId)}" data-i18n="role">${esc(t("role"))}</label><input id="${esc(roleId)}" value="${esc(t("defaultRole"))}" data-role-preset="defaultRole" data-role-edited="false"></div></div>`,
      `<div id="${esc(item.id)}CliSetup" class="cli-setup" aria-live="polite" hidden></div>`,
      `<div id="${esc(item.id)}RunState" class="run-state" role="status" aria-live="polite" data-i18n="ready">${esc(t("ready"))}</div>`,
    ].join("");
    grid.appendChild(card);
    $(roleId).addEventListener("input", (event) => { event.currentTarget.dataset.roleEdited = "true"; });
  }

  const fillSelect = (element, filter = () => true) => {
    element.innerHTML = "";
    for (const item of providers.filter(filter)) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      element.appendChild(option);
    }
  };
  fillSelect($("finalizer"));
  const none = document.createElement("option");
  none.value = "none";
  none.dataset.i18n = "none";
  none.textContent = t("none");
  $("finalizer").appendChild(none);
  fillSelect($("execExecutor"), (item) => item.capabilities?.executeModes?.length);
  fillSelect($("execReviewer"));
  const runProvider = providers.find((item) => item.capabilities?.executeModes?.includes("run"));
  if (runProvider) $("execExecutor").value = runProvider.id;
  const alternate = providers.find((item) => item.id !== $("execExecutor").value);
  if (alternate) $("execReviewer").value = alternate.id;

  document.querySelectorAll(".check-cli").forEach((button) => { button.onclick = () => checkCli(button.dataset.agent); });
  document.querySelectorAll(".setup-cli").forEach((button) => { button.onclick = () => toggleCliSetup(button.dataset.agent); });
  document.querySelectorAll(".load-models").forEach((button) => { button.onclick = () => loadModels(button.dataset.agent, button); });
  settingsIds().forEach((id) => { const element = $(id); if (element) element.addEventListener("change", () => { saveSettings(); updateSetupSummary(); }); });
}

/* ---------------- mode + setup drawer ---------------- */
function setMode(next, silent) {
  mode = next === "debate" ? "debate" : next === "chat" ? "chat" : "collaboration";
  document.querySelectorAll(".mode-btn").forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  providers.forEach((item, index) => {
    const preset = mode === "debate"
      ? (index === 0 ? "debateAdvocateRole" : "debateChallengerRole")
      : "defaultRole";
    applyRolePreset($(`${item.id}Role`), preset);
  });
  // Chat is a single independent pass per message — rounds and finalizer don't apply.
  const isChat = mode === "chat";
  $("rounds").disabled = isChat;
  $("finalizer").disabled = isChat;
  updateSetupSummary();
  if (!silent) saveSettings();
}
function toggleSetup() {
  const drawer = $("setupDrawer");
  const open = drawer.hidden;
  drawer.hidden = !open;
  $("setupToggle").setAttribute("aria-expanded", String(open));
  if (open) {
    $("execDrawer").hidden = true;
    $("execToggle").setAttribute("aria-expanded", "false");
  }
}
function updateSetupSummary() {
  const parts = providers.filter((item) => $(`${item.id}Enabled`)?.checked).map((item) => item.label);
  const modeLabel = discussionModeLabel(mode);
  const roundsPart = mode === "chat" ? "" : ` · ${formatLocaleNumber(lang, $("rounds").value)} ${t("roundsShort")}`;
  $("setupSummary").textContent = `${modeLabel} · ${parts.join(" + ") || "—"}${roundsPart}`;
}

/* ---------------- sessions rail ---------------- */
function discussionModeLabel(value) {
  return { collaboration: t("modeCollab"), debate: t("modeDebate"), chat: t("modeChat"), idle: t("statusIdle") }[value] || String(value || "");
}

function sessionStatusLabel(status) {
  const key = {
    idle: "statusIdle",
    running: "statusRunning",
    completed: "statusCompleted",
    error: "statusError",
    interrupted: "statusInterrupted",
  }[status];
  return key ? t(key) : String(status || t("statusIdle"));
}

function phaseLabel(phase) {
  const key = {
    chat: "phaseChat",
    collaboration: "phaseCollaboration",
    opening: "phaseOpening",
    rebuttal: "phaseRebuttal",
    synthesis: "phaseSynthesis",
    converged: "phaseConverged",
    needs_more_rounds: "phaseNeedsMoreRounds",
  }[phase];
  return key ? t(key) : String(phase || "");
}

async function refreshSessions() {
  let sessions = [];
  try { sessions = await api("/api/sessions"); } catch { return; }
  const list = $("sessionList");
  list.innerHTML = "";
  for (const s of sessions) {
    const btn = document.createElement("button");
    btn.className = `session-item ${s.id === currentSessionId ? "is-active" : ""}`;
    if (s.id === currentSessionId) btn.setAttribute("aria-current", "page");
    const title = document.createElement("div"); title.className = "si-title"; title.textContent = s.title;
    const sub = document.createElement("div"); sub.className = "si-sub";
    const dot = document.createElement("span"); dot.className = `si-dot ${s.status || ""}`; dot.setAttribute("aria-hidden", "true");
    const meta = document.createElement("span"); meta.textContent = `${discussionModeLabel(s.mode)} · ${formatMessageCount(lang, s.messageCount)} · ${sessionStatusLabel(s.status)}`;
    sub.append(dot, meta); btn.append(title, sub);
    btn.onclick = () => openSession(s.id);
    list.appendChild(btn);
  }
}

/* ---------------- session open / focused view ---------------- */
async function openSession(id) {
  const switching = currentSessionId !== id;
  if (switching) sessionViewEpoch += 1;
  const viewEpoch = sessionViewEpoch;
  sessionRequests.invalidate();
  connectorRequests.invalidate();
  currentSessionId = id;
  currentSession = null;
  routeSuggestion = null;
  pendingExec = null;
  renderedMessageSessionId = null;
  renderedMessageIds = new Set();
  running = false;
  if (activeModal === $("approveModal")) closeManagedModal($("approveModal"), { restoreFocus: false });
  $("messageInput").disabled = true;
  $("sendBtn").disabled = true;
  $("stopBtn").disabled = true;
  $("execStopBtn").hidden = true;
  $("execRun").disabled = true;
  $("exportBtn").disabled = true;
  $("projectPath").value = "";
  $("projectStatus").textContent = "";
  $("projectStatus").className = "run-state";
  $("trustProject").hidden = true;
  $("chat").innerHTML = "";
  $("connectorsList").innerHTML = "";
  if (switching) {
    $("sessionTitle").textContent = "—";
    $("sessionMeta").textContent = "";
    $("messageInput").value = "";
    autoGrow($("messageInput"));
    $("execTask").value = "";
    $("execStatus").textContent = "";
    $("liveStatus").textContent = t("ready");
    for (const item of providers) setAgentState(item.id, t("ready"));
  }
  if (eventSource) eventSource.close();
  const source = new EventSource(`/api/sessions/${id}/events`);
  eventSource = source;
  source.onmessage = (e) => { if (eventSource === source && isCurrentSessionView(id, viewEpoch)) handleEvent(JSON.parse(e.data)); };
  source.onopen = () => { if (eventSource === source && isCurrentSessionView(id, viewEpoch)) setConnected(true); };
  source.onerror = () => { if (eventSource === source && isCurrentSessionView(id, viewEpoch)) setConnected(false); };
  $("emptyState").hidden = true;
  $("sessionView").hidden = false;
  try { await loadSession(); }
  catch (error) {
    if (isCurrentSessionView(id, viewEpoch)) {
      $("liveStatus").textContent = localizedFailure(error);
      $("messageInput").disabled = true;
      $("sendBtn").disabled = true;
      $("execRun").disabled = true;
      $("exportBtn").disabled = true;
    }
  }
  if (isCurrentSessionView(id, viewEpoch)) await refreshSessions();
}

async function loadSession() {
  const requestedId = currentSessionId;
  if (!requestedId) { sessionRequests.invalidate(); connectorRequests.invalidate(); return false; }
  const result = await sessionRequests.run(requestedId);
  if (!result.current || currentSessionId !== requestedId) return false;
  currentSession = result.value;
  const orchestrating = Boolean(currentSession.running || currentSession.status === "running");
  const executing = Boolean(currentSession.executing);
  running = orchestrating || executing;
  const controls = activityControls(running, executing ? "execution" : "orchestration");
  loadSessionMeta();
  $("messageInput").disabled = running;
  $("sendBtn").disabled = running;
  $("stopBtn").disabled = controls.mainStopDisabled;
  $("execStopBtn").hidden = controls.executionStopHidden;
  $("execRun").disabled = controls.executionRunDisabled;
  $("exportBtn").disabled = false;
  if (currentSession.project?.path) {
    $("projectPath").value = currentSession.project.path;
    const trusted = currentSession.project.trusted === true;
    $("projectStatus").innerHTML = trusted ? `${esc(t("attached"))}: ${bdi(currentSession.project.path, "ltr")}` : esc(t("untrustedProject"));
    $("projectStatus").className = `run-state ${trusted ? "done" : ""}`;
    $("trustProject").hidden = trusted;
  } else {
    $("projectPath").value = "";
    $("projectStatus").textContent = "";
    $("projectStatus").className = "run-state";
    $("trustProject").hidden = true;
  }
  renderMessages();
  loadConnectors();
  return true;
}
function loadSessionMeta() {
  if (!currentSession) return;
  $("sessionTitle").textContent = currentSession.title;
  $("sessionMeta").textContent = `${discussionModeLabel(currentSession.mode)} · ${formatMessageCount(lang, currentSession.messages.length)} · ${sessionStatusLabel(currentSession.status)}`;
}

/* ---------------- messages ---------------- */
function esc(text) {
  return String(text ?? "").replace(/[&<>'"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;" }[c]));
}
function fmtDuration(ms) {
  return ms == null ? "" : formatLocaleDuration(lang, ms);
}
function technicalDetailsHtml(detail) {
  return detail ? `<details class="tech"><summary>${esc(t("techDetails"))}</summary><pre>${esc(String(detail).slice(0, 8000))}</pre></details>` : "";
}
function renderMessages() {
  const chat = $("chat");
  const messages = currentSession?.messages ?? [];
  let freshMessages = [];
  if (renderedMessageSessionId === currentSessionId) {
    freshMessages = messages.filter((message) => message.id && !renderedMessageIds.has(message.id));
  }
  renderedMessageSessionId = currentSessionId;
  renderedMessageIds = new Set(messages.map((message) => message.id).filter(Boolean));
  chat.setAttribute("aria-busy", "true");
  chat.innerHTML = "";
  renderSessionInsights(chat);
  for (const msg of messages) {
    const meta = msg.meta || {};
    const isPartial = meta.status === "partial";
    const isError = meta.status === "error";
    const el = document.createElement("article");
    el.className = `msg msg-${msg.author}${isPartial ? " msg-partial" : ""}${isError ? " msg-error" : ""}`;
    const time = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString(lang === "ar" ? "ar-EG" : "en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
    const appError = isError || msg.phase === "exec_error";
    const errorDetail = appError ? [meta.error || msg.content, meta.technical].filter(Boolean).join("\n\n") : meta.technical;
    const techHtml = technicalDetailsHtml(errorDetail);

    if (msg.author === "agent") {
      const info = providerInfo(msg.agent);
      const name = info.label;
      const badges = [msg.role, phaseLabel(msg.phase), msg.round ? `${t("roundWord")} ${formatLocaleNumber(lang, msg.round)}` : "", isPartial ? t("partialTag") : ""]
        .filter(Boolean)
        .map((b) => `<span class="badge${isPartial && b === t("partialTag") ? " badge-partial" : ""}">${esc(b)}</span>`).join("");
      const metaParts = [meta.requestedModel ? bdi(meta.requestedModel, "ltr") : "", meta.requestedEffort ? bdi(meta.requestedEffort, "ltr") : "", fmtDuration(meta.durationMs) ? esc(fmtDuration(meta.durationMs)) : "", meta.outputTruncated ? esc(t("truncatedTag")) : ""].filter(Boolean);
      const ctx = meta.contextChars ? ` · ${esc(t("contextWord"))} ${bdi(formatLocaleNumber(lang, meta.contextChars))}` : "";
      const footer = metaParts.length ? `<div class="msg-meta">${metaParts.join(" · ")}${ctx}</div>` : "";
      el.innerHTML =
        `<div class="msg-head"><span class="agent-avatar ${esc(info.id)}" aria-hidden="true">${esc(name.slice(0, 1))}</span>` +
        `<span class="msg-name">${bdi(name)}</span>${badges}<span class="msg-time">${bdi(time)}</span></div>` +
        `<div class="msg-body"><div class="msg-content" dir="auto">${esc(msg.content)}</div>${footer}${techHtml}</div>`;
    } else if (msg.author === "user") {
      el.innerHTML = `<div class="msg-body"><div class="msg-content" dir="auto">${esc(msg.content)}</div></div>`;
    } else {
      el.innerHTML = `<div class="msg-body" dir="auto">${appError ? esc(msg.phase === "exec_error" ? t("executionFailed") : t("runFailed")) : esc(msg.content)}</div>${techHtml}`;
    }
    chat.appendChild(el);
  }
  renderExecutions();
  // Completed sessions open at the first message (read from the top); live runs follow the newest.
  chat.scrollTop = running ? chat.scrollHeight : 0;
  chat.setAttribute("aria-busy", "false");
  const latest = freshMessages.filter((message) => message.author !== "user").pop();
  if (latest) {
    const speaker = latest.author === "agent" ? providerInfo(latest.agent).label : t("system");
    const announcement = $("conversationAnnouncements");
    announcement.textContent = "";
    requestAnimationFrame(() => { announcement.textContent = `${t("newMessageFrom")(speaker)}: ${String(latest.content || "").slice(0, 500)}`; });
  }
}

function renderSessionInsights(chat) {
  if (!currentSession) return;
  const discussion = (currentSession.messages || []).filter((message) => message.author === "agent" && ["collaboration", "opening", "rebuttal"].includes(message.phase));
  const completed = Math.max(0, ...discussion.map((message) => Number(message.round) || 0));
  const requested = Number(currentSession.settings?.rounds) || 0;
  const finalReport = [...(currentSession.messages || [])].reverse().find((message) => ["converged", "needs_more_rounds"].includes(message.phase));
  const openPoints = [...new Set(discussion.flatMap((message) => message.control?.openPoints || []).filter(Boolean))];
  const corrections = discussion.filter((message) => message.control?.substantiveDelta).map((message) => ({ agent: message.agent, content: String(message.content || "").slice(0, 140) }));
  if (requested || completed) {
    const card = document.createElement("section");
    card.className = "session-insight";
    card.innerHTML = `<h2>${esc(t("roundTracker"))}</h2><div class="insight-metrics"><span>${esc(t("requested"))}: <b>${bdi(formatLocaleNumber(lang, requested))}</b></span><span>${esc(t("completed"))}: <b>${bdi(formatLocaleNumber(lang, completed))}</b></span></div>${finalReport ? `<p dir="auto">${esc(finalReport.content)}</p>` : ""}${corrections.length ? `<p><b>${esc(t("corrections"))}:</b> ${corrections.map((correction) => `${bdi(correction.agent, "ltr")}: <span dir="auto">${esc(correction.content)}</span>`).join(" · ")}</p>` : ""}${openPoints.length ? `<p><b>${esc(t("unresolved"))}:</b> ${openPoints.map((point) => `<span dir="auto">${esc(point)}</span>`).join(" · ")}</p>` : ""}`;
    chat.appendChild(card);
  }
  if (currentSession.decisions?.length) {
    const card = document.createElement("section");
    card.className = "session-insight";
    const items = currentSession.decisions.slice(-8).map((decision) => {
      const type = localizedMarkup(decisionTypeKey(decision.type), decision.type);
      const outcome = localizedMarkup(decisionOutcomeKey(decision.outcome), decision.outcome);
      const connectorId = decision.metadata?.connector;
      const actionId = decision.metadata?.action || decision.metadata?.requestedAction;
      const actionKey = connectorId ? connectorActionKeys(connectorId, actionId)?.label : decisionActionKey(actionId);
      const context = actionId
        ? localizedMarkup(actionKey, actionId)
        : connectorId ? localizedMarkup(connectorLabelKey(connectorId), connectorId) : "";
      return `<li><b>${outcome}</b> · ${type}${context ? ` (${context})` : ""}</li>`;
    }).join("");
    card.innerHTML = `<h2>${esc(t("decisionLog"))}</h2><ul>${items}</ul>`;
    chat.appendChild(card);
  }
  if (routeSuggestion) {
    const card = document.createElement("section");
    card.className = "session-insight route-suggestion";
    card.innerHTML = `<p>${esc(t(errorMessageKey(routeSuggestion)))}</p><button class="btn-primary">${esc(t("routeAction"))}</button>`;
    card.querySelector("button").onclick = () => {
      $("execDrawer").hidden = false;
      $("execToggle").setAttribute("aria-expanded", "true");
      $("setupDrawer").hidden = true;
      $("setupToggle").setAttribute("aria-expanded", "false");
      if (routeSuggestion.action === "open_execution") $("execTask").value = $("messageInput").value.trim();
      routeSuggestion = null;
      renderMessages();
    };
    chat.appendChild(card);
  }
}
function autoGrow(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 200) + "px"; }

/* ---------------- SSE ---------------- */
function handleEvent(event) {
  if (event.type === "session_updated") loadSession();
  if (event.type === "run_started") setRunning(true, `${discussionModeLabel(event.mode)} · ${formatLocaleNumber(lang, event.rounds)} ${t("roundsShort")}`);
  if (event.type === "agent_start") { setAgentState(event.agent, `${phaseLabel(event.phase)} · ${t("roundWord")} ${formatLocaleNumber(lang, event.round)}`, "running"); $("liveStatus").textContent = t("working")(event.label); }
  if (event.type === "agent_activity" && event.event?.text) setAgentState(event.agent, event.event.text.slice(0, 90), "running");
  if (event.type === "agent_complete") setAgentState(event.agent, t("replied"), "done");
  if (["run_complete","run_stopped","run_error"].includes(event.type)) {
    setRunning(false, event.type === "run_complete" ? t("runDone") : event.type === "run_stopped" ? t("runStopped") : localizedFailure({ code: event.code, detail: event.error }));
    loadSession(); refreshSessions();
  }
  if (event.type === "exec_started") setRunning(true, t("starting"), "execution");
  if (event.type === "exec_phase") { const s = event.phase === "executing" ? t("execExecuting")(event.agent) : t("execReviewing")(event.agent); $("execStatus").textContent = s; $("liveStatus").textContent = s; }
  if (event.type === "exec_ready") { setRunning(false, t("execAwaiting")); $("execStopBtn").hidden = true; $("execRun").disabled = false; $("execTask").value = ""; loadSession(); refreshSessions(); }
  if (event.type === "exec_error") { setRunning(false, localizedFailure({ code: event.code, detail: event.error })); $("execStopBtn").hidden = true; $("execRun").disabled = false; loadSession(); refreshSessions(); }
}
function setAgentState(agent, text, cls = "") { const el = $(`${agent}RunState`); if (el) { el.textContent = text; el.className = `run-state ${cls}`; } }
function setRunning(value, status, kind = "orchestration") {
  running = value;
  const controls = activityControls(value, kind);
  $("messageInput").disabled = value || !currentSessionId;
  $("sendBtn").disabled = value || !currentSessionId;
  $("stopBtn").disabled = controls.mainStopDisabled;
  $("execStopBtn").hidden = controls.executionStopHidden;
  $("execRun").disabled = controls.executionRunDisabled;
  if (status) $("liveStatus").textContent = status;
}

/* ---------------- send ---------------- */
function payload() {
  return {
    content: $("messageInput").value.trim(), mode, rounds: Number($("rounds").value), finalizer: $("finalizer").value,
    agents: providerPayload(true),
  };
}

function providerPayload(includeRole = false) {
  return Object.fromEntries(providers.map((item) => [item.id, {
    enabled: $(`${item.id}Enabled`)?.checked ?? true,
    command: $(`${item.id}Command`)?.value.trim() || item.command,
    model: $(`${item.id}Model`)?.value.trim() || "",
    effort: $(`${item.id}Effort`)?.value || "high",
    ...(includeRole ? { role: $(`${item.id}Role`)?.value.trim() || t("defaultRole") } : {}),
  }]));
}
async function sendMessage() {
  if (!currentSessionId || running) return;
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  const body = payload();
  if (!body.content) { $("liveStatus").textContent = t("writeFirst"); return; }
  saveSettings();
  setRunning(true, t("starting"));
  try {
    await api(`/api/sessions/${requestedId}/message`, { method: "POST", body: JSON.stringify(body) });
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    $("messageInput").value = "";
    autoGrow($("messageInput"));
  } catch (error) {
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    setRunning(false, localizedFailure(error));
    if (error.route) {
      routeSuggestion = error.route;
      renderMessages();
    }
  }
}

/* ---------------- cli check / models ---------------- */
async function checkCli(agent) {
  const command = $(`${agent}Command`).value.trim();
  const health = $(`${agent}Health`);
  health.textContent = "..."; health.className = "health";
  try {
    const result = await api("/api/cli/check", { method: "POST", body: JSON.stringify({ provider: agent, command }) });
    health.textContent = result.ok ? result.version : localizedFailure(result);
    health.className = `health ${result.ok ? "ok" : "bad"}`;
    return result.ok === true;
  } catch (error) { health.textContent = localizedFailure(error); health.className = "health bad"; return false; }
}
function toggleCliSetup(agent) {
  const panel = $(`${agent}CliSetup`);
  const button = document.querySelector(`.setup-cli[data-agent="${agent}"]`);
  if (!panel.hidden) {
    panel.hidden = true;
    button?.setAttribute("aria-expanded", "false");
    return;
  }
  panel.hidden = false;
  button?.setAttribute("aria-expanded", "true");
  runCliSetup(agent);
}

const cliSetupInFlight = new Set();
async function runCliSetup(agent) {
  if (cliSetupInFlight.has(agent)) return;
  cliSetupInFlight.add(agent);
  const panel = $(`${agent}CliSetup`);
  panel.textContent = t("setupSearching");
  let result;
  try {
    result = await api("/api/cli/discover", { method: "POST", body: JSON.stringify({ provider: agent }) });
  } catch (error) {
    panel.textContent = localizedFailure(error);
    return;
  } finally {
    cliSetupInFlight.delete(agent);
  }
  // Built offline and inserted in one mutation so the polite live region
  // announces the result as one coherent message, not fragment by fragment.
  const fragment = document.createDocumentFragment();
  if (result.resolved) {
    const ok = document.createElement("p");
    ok.className = "cli-setup-ok";
    ok.textContent = t("setupCommandOk");
    fragment.appendChild(ok);
    const resolvedPath = document.createElement("div");
    resolvedPath.className = "cli-setup-path";
    resolvedPath.innerHTML = bdi(result.resolved, "ltr");
    fragment.appendChild(resolvedPath);
  }
  if (result.candidates?.length) {
    const intro = document.createElement("p");
    intro.className = "cli-setup-intro";
    intro.textContent = t("setupFoundIntro");
    fragment.appendChild(intro);
    for (const candidate of result.candidates) {
      const row = document.createElement("div");
      row.className = "cli-setup-row";
      row.innerHTML = `<span class="cli-setup-path">${bdi(candidate, "ltr")}</span>`;
      const use = document.createElement("button");
      use.className = "btn-mini";
      use.textContent = t("useThisPath");
      use.setAttribute("aria-label", `${t("useThisPath")}: ${candidate}`);
      use.onclick = async () => {
        $(`${agent}Command`).value = candidate;
        saveSettings();
        use.disabled = true;
        const ok = await checkCli(agent);
        use.disabled = false;
        if (ok) runCliSetup(agent);
      };
      row.appendChild(use);
      fragment.appendChild(row);
    }
  } else if (!result.resolved) {
    const info = providerInfo(agent);
    const none = document.createElement("p");
    none.className = "cli-setup-intro";
    none.textContent = t("setupNoneFound");
    fragment.appendChild(none);
    if (info.install?.command) {
      const row = document.createElement("div");
      row.className = "cli-setup-row";
      row.innerHTML = `<code class="cli-setup-cmd">${bdi(info.install.command, "ltr")}</code>`;
      const copy = document.createElement("button");
      copy.className = "btn-mini";
      copy.textContent = t("copyCommand");
      // Feedback lives beside the button so its accessible name stays stable;
      // the panel's live region announces the span's text change.
      const feedback = document.createElement("span");
      feedback.className = "cli-setup-feedback";
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(info.install.command); feedback.textContent = t("copied"); }
        catch { feedback.textContent = t("copyFailed"); }
        setTimeout(() => { feedback.textContent = ""; }, 1600);
      };
      row.appendChild(copy);
      row.appendChild(feedback);
      fragment.appendChild(row);
    }
    if (info.install?.url && /^https:\/\//.test(info.install.url)) {
      const docs = document.createElement("a");
      docs.className = "cli-setup-docs";
      docs.href = info.install.url;
      docs.target = "_blank";
      docs.rel = "noreferrer noopener";
      docs.textContent = t("installDocs");
      const newTab = document.createElement("span");
      newTab.className = "sr-only";
      newTab.textContent = ` (${t("opensInNewTab")})`;
      docs.appendChild(newTab);
      fragment.appendChild(docs);
    }
  }
  panel.replaceChildren(fragment);
}

async function loadModels(agent, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = "...";
  try {
    const result = await api(`/api/providers/${encodeURIComponent(agent)}/models`, { method: "POST", body: JSON.stringify({ command: $(`${agent}Command`).value.trim() }) });
    if (result.code) throw failureFromPayload(result);
    const list = $(`${agent}Models`); list.innerHTML = "";
    for (const m of result.models) { const o = document.createElement("option"); o.value = m; list.appendChild(o); }
  } catch (error) { btn.title = localizedFailure(error); }
  finally { btn.disabled = false; btn.textContent = old; }
}

/* ---------------- new session modal ---------------- */
function openNewSessionModal() {
  $("newSessionName").value = ""; $("newSessionFirst").value = "";
  chosenProject = null; $("projChosen").classList.add("hidden");
  $("fsList").dataset.loaded = ""; $("repoList").dataset.loaded = ""; if ($("repoSearch")) $("repoSearch").value = "";
  setProjTab("none");
  hideModalError();
  openManagedModal($("newSessionModal"), { initialFocus: $("newSessionName"), dismiss: closeNewSessionModal });
}
function closeNewSessionModal() { closeManagedModal($("newSessionModal")); }
function showModalError(m) { const el = $("newSessionError"); el.textContent = m; el.classList.remove("hidden"); }
function hideModalError() { const el = $("newSessionError"); el.textContent = ""; el.classList.add("hidden"); }
async function confirmNewSession() {
  const title = $("newSessionName").value.trim() || t("newSession");
  const first = $("newSessionFirst").value.trim();
  hideModalError();
  const createBtn = $("newSessionCreate"); createBtn.disabled = true;
  try {
    const session = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title }) });
    if (chosenProject) {
      let projectPath = chosenProject.path;
      if (chosenProject.type === "github") {
        showChosen(t("cloning"));
        const cl = await api("/api/github/clone", { method: "POST", body: JSON.stringify({ repo: chosenProject.repo }) });
        projectPath = cl.path;
      }
      await api(`/api/sessions/${session.id}/project`, { method: "POST", body: JSON.stringify({ path: projectPath }) });
    }
    closeNewSessionModal();
    await refreshSessions();
    await openSession(session.id);
    if (first) $("messageInput").value = first;
    $("messageInput").focus();
  } catch (error) { showModalError(localizedFailure(error)); }
  finally { createBtn.disabled = false; }
}

/* ---------------- connection ---------------- */
function setConnected(ok) {
  $("serverStatus").classList.toggle("is-bad", !ok);
  $("connText").textContent = ok ? t("connected") : t("disconnected");
}
async function pollHealth() { try { await api("/api/health"); setConnected(true); } catch { setConnected(false); } }

/* ---------------- onboarding ---------------- */
async function loadOnboard() {
  const list = $("onboardList"); list.textContent = "...";
  try {
    const s = await api("/api/agents/status");
    list.innerHTML = "";
    const rows = [
      ...providers.map((item) => ({ name: item.label, ok: s.providers?.[item.id]?.installed, detail: s.providers?.[item.id]?.version || s.providers?.[item.id]?.detail, agent: item.id })),
      { name: "GitHub (gh)", ok: s.github.authed, detail: s.github.detail, agent: null },
    ];
    for (const r of rows) {
      const row = document.createElement("div"); row.className = "onboard-row";
      const state = r.ok ? t("installed") : t("notInstalled");
      if (!r.ok && r.detail) console.error(`[Agent Room: provider_check_failed] ${r.detail}`);
      const detail = [state, r.ok ? r.detail : ""].filter(Boolean).join(" · ");
      row.innerHTML = `<span class="onboard-dot ${r.ok ? "ok" : "bad"}" aria-hidden="true"></span><span class="ob-name">${esc(r.name)}</span><span class="ob-detail">${esc(detail)}</span>`;
      const actions = document.createElement("span"); actions.className = "ob-actions";
      if (r.agent && !r.ok) {
        const setupBtn = document.createElement("button"); setupBtn.className = "btn-mini"; setupBtn.textContent = t("setupCli");
        setupBtn.setAttribute("aria-label", t("setupProviderCli")(providerInfo(r.agent).label));
        setupBtn.onclick = () => openCliSetupFromOnboard(r.agent);
        actions.appendChild(setupBtn);
      }
      if (r.agent && providerInfo(r.agent).canUpdate) {
        const btn = document.createElement("button"); btn.className = "btn-mini"; btn.textContent = t("update");
        btn.onclick = () => updateAgentCli(r.agent, btn);
        actions.appendChild(btn);
      }
      if (actions.childElementCount > 0) row.appendChild(actions);
      list.appendChild(row);
    }
  } catch (e) { list.textContent = localizedFailure(e); }
}
function openCliSetupFromOnboard(agent) {
  // Close without the modal's focus restore: focus must land on the setup
  // button, and the restore RAF would otherwise override a synchronous focus.
  closeManagedModal($("onboardModal"), { restoreFocus: false });
  localStorage.setItem("agent-room-onboarded", "1");
  if ($("setupDrawer").hidden) toggleSetup();
  const panel = $(`${agent}CliSetup`);
  if (panel.hidden) toggleCliSetup(agent);
  else runCliSetup(agent);
  document.querySelector(`.agent-card[data-agent="${agent}"]`)?.scrollIntoView({ block: "nearest" });
  requestAnimationFrame(() => document.querySelector(`.setup-cli[data-agent="${agent}"]`)?.focus());
}
async function updateAgentCli(agent, btn) {
  btn.disabled = true; btn.textContent = t("updating");
  try {
    const r = await api("/api/agents/update", { method: "POST", body: JSON.stringify({ agent }) });
    btn.textContent = r.ok ? "✓" : "!";
    setTimeout(loadOnboard, 1000);
  } catch (e) { btn.textContent = "!"; btn.title = localizedFailure(e); btn.disabled = false; }
}

/* project picker (new-session modal) */
let projMode = "none";
let chosenProject = null;
let repoCache = [];
function setProjTab(mode) {
  projMode = mode;
  document.querySelectorAll(".proj-tab").forEach((b) => {
    const active = b.dataset.proj === mode;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  $("projLocalPane").hidden = mode !== "local";
  $("projGithubPane").hidden = mode !== "github";
  if (mode === "none") { chosenProject = null; $("projChosen").classList.add("hidden"); }
  if (mode === "local" && $("fsList").dataset.loaded !== "1") fsNavigate("");
  if (mode === "github" && $("repoList").dataset.loaded !== "1") loadRepos();
}
function showChosen(value, { icon = "", technical = false } = {}) {
  const el = $("projChosen");
  const content = technical ? bdi(value, "ltr") : `<span dir="auto">${esc(value)}</span>`;
  el.innerHTML = `<span aria-hidden="true">✓${icon ? ` ${esc(icon)}` : ""}</span> ${content}`;
  el.classList.remove("hidden");
}
async function fsNavigate(p) {
  const list = $("fsList"); list.innerHTML = `<div class="fs-empty">…</div>`;
  try {
    const r = await api(`/api/fs/list?path=${encodeURIComponent(p)}`);
    list.dataset.loaded = "1";
    $("fsPath").innerHTML = r.path ? bdi(r.path, "ltr") : "—";
    $("fsUp").dataset.parent = r.parent ?? "";
    $("fsUp").disabled = r.parent === null;
    list.innerHTML = "";
    if (r.path) {
      const cur = document.createElement("div"); cur.className = "fs-item";
      cur.innerHTML = `${r.isGit ? '<span class="fs-git">git</span>' : '<span class="fs-ic" aria-hidden="true">📂</span>'}<span class="fs-name">${esc(t("useFolder"))} ← ${bdi(r.path, "ltr")}</span><button class="fs-use">${esc(t("useFolder"))}</button>`;
      cur.querySelector(".fs-use").onclick = () => { chosenProject = { type: "local", path: r.path }; showChosen(r.path, { icon: "📁", technical: true }); };
      list.appendChild(cur);
    }
    for (const d of r.dirs) {
      const row = document.createElement("button"); row.type = "button"; row.className = "fs-item fs-item-button";
      row.setAttribute("aria-label", t("openFolder")(d.name));
      row.innerHTML = `<span class="fs-ic" aria-hidden="true">📁</span><span class="fs-name">${bdi(d.name)}</span>`;
      row.onclick = () => fsNavigate(d.path);
      list.appendChild(row);
    }
    if (!r.dirs.length && !r.path) list.innerHTML = `<div class="fs-empty">${esc(t("noFolders"))}</div>`;
  } catch (e) { list.innerHTML = `<div class="fs-empty">${esc(localizedFailure(e))}</div>`; }
}
async function loadRepos() {
  const list = $("repoList"); list.innerHTML = `<div class="fs-empty">…</div>`;
  try {
    const r = await api("/api/github/repos");
    if (r.code) throw failureFromPayload(r);
    list.dataset.loaded = "1";
    repoCache = r.repos || [];
    renderRepos("");
  } catch (e) { list.innerHTML = `<div class="fs-empty">${esc(localizedFailure(e))}</div>`; }
}
function renderRepos(q) {
  const list = $("repoList"); list.innerHTML = "";
  const repos = repoCache.filter((r) => r.nameWithOwner.toLowerCase().includes(q.toLowerCase()));
  if (!repos.length) { list.innerHTML = `<div class="fs-empty">${esc(t("noRepos"))}</div>`; return; }
  for (const r of repos.slice(0, 60)) {
    const row = document.createElement("button"); row.type = "button"; row.className = "fs-item fs-item-button";
    row.setAttribute("aria-label", t("selectRepository")(r.nameWithOwner));
    row.innerHTML = `<span class="fs-ic" aria-hidden="true">◉</span><span class="fs-name">${bdi(r.nameWithOwner, "ltr")}</span><span class="repo-vis">${bdi(r.visibility, "ltr")}</span>`;
    row.onclick = () => { chosenProject = { type: "github", repo: r.nameWithOwner }; showChosen(r.nameWithOwner, { icon: "◉", technical: true }); };
    list.appendChild(row);
  }
}
function openOnboard() {
  const modal = $("onboardModal");
  openManagedModal(modal, { initialFocus: modal.querySelector(".modal"), dismiss: closeOnboard });
  loadOnboard();
}
function closeOnboard() {
  closeManagedModal($("onboardModal"));
  localStorage.setItem("agent-room-onboarded", "1");
}

/* ---------------- project + execute ---------------- */
function toggleExec() {
  const drawer = $("execDrawer");
  const open = drawer.hidden;
  drawer.hidden = !open;
  $("execToggle").setAttribute("aria-expanded", String(open));
  if (open) {
    $("setupDrawer").hidden = true;
    $("setupToggle").setAttribute("aria-expanded", "false");
  }
}
async function attachProject() {
  const p = $("projectPath").value.trim(); if (!p || !currentSessionId) return;
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  const st = $("projectStatus"); st.textContent = "..."; st.className = "run-state";
  try {
    const r = await api(`/api/sessions/${requestedId}/project`, { method: "POST", body: JSON.stringify({ path: p }) });
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    st.textContent = t("untrustedProject");
    st.className = "run-state";
    $("trustProject").hidden = false;
    if (currentSession) currentSession.project = r.project;
  } catch (e) { if (isCurrentSessionView(requestedId, requestedEpoch)) st.textContent = localizedFailure(e); }
}
async function trustProject() {
  if (!currentSession?.project || !window.confirm(t("trustPrompt"))) return;
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  const fingerprint = currentSession.project.fingerprint;
  try {
    const response = await api(`/api/sessions/${requestedId}/project-trust`, {
      method: "POST",
      body: JSON.stringify({ fingerprint }),
    });
    if (!isCurrentSessionView(requestedId, requestedEpoch) || !currentSession) return;
    currentSession.project = response.project;
    await loadSession();
  } catch (error) {
    if (isCurrentSessionView(requestedId, requestedEpoch)) $("projectStatus").textContent = localizedFailure(error);
  }
}
async function loadConnectors() {
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  if (!requestedId) { connectorRequests.invalidate(); return; }
  const list = $("connectorsList");
  try {
    const request = await connectorRequests.run(requestedId);
    if (!request.current || !isCurrentSessionView(requestedId, requestedEpoch)) return;
    const { data, configuration } = request.value;
    const configs = new Map((configuration.connectors || []).map((item) => [item.id, item]));
    list.innerHTML = "";
    for (const connector of data.connectors) {
      const enabled = data.enabled?.[connector.id]?.enabled === true;
      const config = configs.get(connector.id);
      const connectorName = localizedMarkup(connectorLabelKey(connector.id), connector.label || connector.id);
      const descriptions = connector.actions.map((action) => localizedMarkup(connectorActionKeys(connector.id, action.id)?.description, action.id)).join(" · ");
      const row = document.createElement("div");
      row.className = "connector-row";
      row.innerHTML = `<div><b>${connectorName}</b><small>${connector.configured ? descriptions : esc(t("notConfigured"))}</small></div><div class="connector-controls">${config ? `<button class="btn-mini" data-config aria-expanded="false">${esc(t("configure"))}</button>` : ""}<button class="btn-mini" data-toggle${!connector.configured ? " disabled" : ""}>${esc(enabled ? t("disable") : t("enable"))}</button></div>`;
      row.querySelector("[data-toggle]").onclick = async () => {
        try {
          await api(`/api/sessions/${requestedId}/connectors/${encodeURIComponent(connector.id)}`, { method: "POST", body: JSON.stringify({ enabled: !enabled }) });
          if (isCurrentSessionView(requestedId, requestedEpoch)) await loadSession();
        } catch (error) {
          if (isCurrentSessionView(requestedId, requestedEpoch)) list.textContent = localizedFailure(error);
        }
      };
      list.appendChild(row);
      row.querySelector("[data-config]")?.addEventListener("click", (event) => {
        const button = event.currentTarget;
        const existing = list.querySelector(`[data-config-form="${connector.id}"]`);
        if (existing) { existing.remove(); button.setAttribute("aria-expanded", "false"); return; }
        const form = document.createElement("div");
        form.className = "connector-config";
        form.dataset.configForm = connector.id;
        form.id = `connector-config-${connector.id}`;
        button.setAttribute("aria-controls", form.id);
        button.setAttribute("aria-expanded", "true");
        const fieldLabels = { "gmail:accessToken": t("gmailAccessToken"), "supabase:url": t("supabaseUrl"), "supabase:key": t("supabaseKey") };
        form.innerHTML = config.editable
          ? `${config.fields.map((field) => { const inputId = `connector-${connector.id}-${field.id}`; return `<label for="${esc(inputId)}">${esc(fieldLabels[`${connector.id}:${field.id}`] || field.label)}</label><input id="${esc(inputId)}" data-field="${esc(field.id)}" type="${field.secret ? "password" : "url"}" placeholder="${field.configured ? "••••••••" : ""}" autocomplete="off">`; }).join("")}<div class="inline"><button type="button" class="btn-primary" data-save>${esc(t("save"))}</button><button type="button" class="btn-danger" data-clear>${esc(t("clear"))}</button><span class="connector-status" role="status" aria-live="polite"></span></div>`
          : `<span class="connector-status" role="status">${esc(t("secureStoreUnavailable"))}</span>`;
        row.after(form);
        const submit = async (clear) => {
          const status = form.querySelector(".connector-status");
          const body = { clear };
          form.querySelectorAll("[data-field]").forEach((input) => { if (input.value) body[input.dataset.field] = input.value; });
          try {
            await api(`/api/connector-config/${encodeURIComponent(connector.id)}`, { method: "POST", body: JSON.stringify(body) });
            await loadConnectors();
          } catch (error) { status.textContent = localizedFailure(error); }
        };
        form.querySelector("[data-save]")?.addEventListener("click", () => submit(false));
        form.querySelector("[data-clear]")?.addEventListener("click", () => submit(true));
      });
    }
    for (const action of (data.actions || []).slice(-20).reverse()) {
      const row = document.createElement("div");
      row.className = "connector-action";
      const connectorName = localizedMarkup(connectorLabelKey(action.connector), action.connector);
      const actionName = localizedMarkup(connectorActionKeys(action.connector, action.action)?.label, action.action);
      const status = localizedMarkup(connectorStatusKey(action.status), action.status);
      const renderedResult = action.result && typeof action.result === "object" ? JSON.stringify(action.result, null, 2) : String(action.result || "");
      const result = action.error ? technicalDetailsHtml(action.error) : renderedResult ? `<pre dir="ltr">${esc(renderedResult)}</pre>` : "";
      row.innerHTML = `<b>${connectorName} · ${actionName}</b><span class="connector-status" role="status" aria-live="polite">${status}</span><pre dir="ltr">${esc(JSON.stringify(action.input, null, 2))}</pre>${result}${action.status === "pending" ? `<div><button class="btn-primary">${esc(t("approveAction"))}</button><button class="btn-danger">${esc(t("rejectAction"))}</button></div>` : ""}`;
      if (action.status === "pending") {
        const decide = async (approve) => {
          try {
            await api(`/api/sessions/${requestedId}/connector-actions/${encodeURIComponent(action.id)}/decide`, { method: "POST", body: JSON.stringify({ approve }) });
            if (isCurrentSessionView(requestedId, requestedEpoch)) await loadSession();
          } catch (error) {
            if (isCurrentSessionView(requestedId, requestedEpoch)) list.textContent = localizedFailure(error);
          }
        };
        const buttons = row.querySelectorAll("button");
        buttons[0].onclick = () => decide(true);
        buttons[1].onclick = () => decide(false);
      }
      list.appendChild(row);
    }
  } catch (error) {
    if (isCurrentSessionView(requestedId, requestedEpoch)) list.textContent = localizedFailure(error);
  }
}
function execPayload() {
  return {
    executor: $("execExecutor").value, reviewer: $("execReviewer").value, mode: $("execMode").value, task: $("execTask").value.trim(),
    agents: providerPayload(false),
  };
}
function syncExecModes() {
  const allowed = providerInfo($("execExecutor").value).capabilities?.executeModes || [];
  for (const option of $("execMode").options) option.disabled = !allowed.includes(option.value);
  if (!allowed.includes($("execMode").value)) $("execMode").value = allowed[0] || "run";
}
let pendingExec = null;
function requestExec() {
  if (!currentSessionId || running) return;
  const body = execPayload();
  if (!body.task) { $("execStatus").textContent = t("writeFirst"); return; }
  if (body.executor === body.reviewer) { $("execStatus").textContent = t("sameAgent"); return; }
  pendingExec = body;
  const executor = bdi(providerInfo(body.executor).label, "ltr");
  const reviewer = bdi(providerInfo(body.reviewer).label, "ltr");
  $("approveBody").innerHTML = `${t("approvalSummary")(executor, esc(modeLabel(body.mode)), reviewer)}<br><br><span dir="auto">${esc(body.task)}</span>`;
  openManagedModal($("approveModal"), { initialFocus: $("approveCancel"), dismiss: cancelExecApproval });
}
async function confirmExec() {
  closeManagedModal($("approveModal"), { restoreFocus: false });
  if (!pendingExec) return;
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  const body = pendingExec;
  pendingExec = null;
  setRunning(true, t("starting"), "execution");
  $("execStopBtn").focus();
  try { await api(`/api/sessions/${requestedId}/execute`, { method: "POST", body: JSON.stringify(body) }); }
  catch (e) {
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    setRunning(false, localizedFailure(e));
    $("execStopBtn").hidden = true;
    $("execRun").disabled = false;
  }
}
function cancelExecApproval() {
  closeManagedModal($("approveModal"));
  pendingExec = null;
}

/* ---------------- execution result cards ---------------- */
function highlightDiff(patch) {
  return String(patch).split("\n").map((l) => {
    const e = esc(l);
    if (l.startsWith("+") && !l.startsWith("+++")) return `<span class="diff-add">${e}</span>`;
    if (l.startsWith("-") && !l.startsWith("---")) return `<span class="diff-del">${e}</span>`;
    if (l.startsWith("@@")) return `<span class="diff-hunk">${e}</span>`;
    return e;
  }).join("\n");
}
function modeLabel(m) { return { run: t("modeRun"), full: t("modeFull") }[m] || m; }
function execStatusLabel(s) { return { awaiting_user: t("execAwaiting"), accepting_merge: t("accepting"), accepting_pr: t("publishing"), rejecting: t("rejecting"), accepted_pending_merge: t("retryMerge"), accepted_pending_pr: t("retryPr"), rejected_cleanup_pending: t("retryCleanup"), merged: t("merged"), pr_opened: t("prOpened"), rejected: t("rejected"), blocked_secret: `🔒 ${t("secretsBlocked")}` }[s] || s; }
function renderExecutions() {
  const chat = $("chat");
  for (const ex of currentSession?.executions ?? []) {
    const el = document.createElement("article"); el.className = "msg exec-card";
    let body = `<div class="exec-body">`;
    body += `<div class="exec-part"><div class="exec-label">${esc(t("executor"))} (${bdi(providerInfo(ex.executor).label, "ltr")})</div><div class="exec-text" dir="auto">${esc(ex.executorText || "")}</div></div>`;
    if (ex.diff?.patch) body += `<div class="exec-part exec-diff"><div class="exec-label">${bdi(ex.diff.files || "", "ltr")}</div><pre>${highlightDiff(ex.diff.patch)}</pre></div>`;
    if (ex.review?.text) body += `<div class="exec-part"><div class="exec-label">${esc(t("reviewer"))} (${bdi(providerInfo(ex.reviewer).label, "ltr")})</div><div class="exec-text" dir="auto">${esc(ex.review.text)}</div></div>`;
    if (ex.executorMeta?.outputTruncated || ex.review?.meta?.outputTruncated) body += `<div class="exec-part"><div class="exec-label">⚠ ${esc(t("truncatedTag"))}</div></div>`;
    if (ex.secretFindings?.length) body += `<div class="exec-part"><div class="exec-label">🔒 ${esc(t("secretScanBlocked"))}</div><div class="exec-text">${ex.secretFindings.map((f) => `${bdi(f.path, "ltr")}${f.line ? `:${bdi(formatLocaleNumber(lang, f.line))}` : ""} — ${bdi(f.rule, "ltr")} (${bdi(f.severity, "ltr")})`).join("<br>")}</div></div>`;
    if (ex.status === "awaiting_user") {
      body += `<div class="exec-decision"><button class="btn-primary" data-accept="merge" data-task="${esc(ex.taskId)}">${esc(t("mergeLocal"))}</button>`;
      if (currentSession.project?.canOpenPr) body += `<button class="btn-ghost" data-accept="pr" data-task="${esc(ex.taskId)}">${esc(t("openPr"))}</button>`;
      body += `<button class="btn-danger" data-reject="${esc(ex.taskId)}">${esc(t("reject"))}</button></div>`;
    } else if (ex.status === "accepted_pending_merge" || ex.status === "accepted_pending_pr") {
      const retryAction = ex.status === "accepted_pending_pr" ? "pr" : "merge";
      body += `<div class="exec-decision"><button class="btn-primary" data-accept="${retryAction}" data-task="${esc(ex.taskId)}">${esc(execStatusLabel(ex.status))}</button></div>`;
    } else if (ex.status === "rejected_cleanup_pending") {
      body += `<div class="exec-decision"><button class="btn-danger" data-reject="${esc(ex.taskId)}">${esc(execStatusLabel(ex.status))}</button></div>`;
    } else {
      const link = ex.prUrl ? ` — <a href="${esc(ex.prUrl)}" target="_blank" rel="noopener">PR</a>` : "";
      body += `<div class="exec-status-line">${esc(execStatusLabel(ex.status))}${link}</div>`;
    }
    body += `</div>`;
    el.innerHTML = `<div class="exec-card-head"><span class="exec-badge">${esc(t("execute"))}</span> <b>${bdi(providerInfo(ex.executor).label, "ltr")}</b> → ${ex.reviewer ? bdi(providerInfo(ex.reviewer).label, "ltr") : "—"} <span class="badge">${esc(modeLabel(ex.mode))}</span> <span class="badge">${esc(execStatusLabel(ex.status))}</span></div>${body}`;
    chat.appendChild(el);
  }
  const lockDecisionButtons = (button) => button.closest(".exec-card")?.querySelectorAll("[data-accept],[data-reject]").forEach((item) => { item.disabled = true; });
  chat.querySelectorAll("[data-accept]").forEach((b) => b.onclick = () => { lockDecisionButtons(b); acceptExec(b.dataset.task, b.dataset.accept); });
  chat.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => { lockDecisionButtons(b); rejectExec(b.dataset.reject); });
}
async function acceptExec(taskId, action) {
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  // Reserve the browser window during the click event. Waiting for the API and
  // session refresh first causes normal popup blockers to reject the PR window.
  const reservedPrWindow = reservePrWindow(window, action);
  let response;
  try {
    response = await api(`/api/sessions/${requestedId}/execution/${taskId}/accept`, { method: "POST", body: JSON.stringify({ action }) });
  } catch (error) {
    closeReservedPrWindow(reservedPrWindow);
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    $("liveStatus").textContent = localizedFailure(error);
    await loadSession();
    return;
  }
  if (!isCurrentSessionView(requestedId, requestedEpoch)) {
    closeReservedPrWindow(reservedPrWindow);
    return;
  }
  openReservedPrWindow(window, reservedPrWindow, response.prUrl);
  try {
    await loadSession();
  } catch (error) {
    if (isCurrentSessionView(requestedId, requestedEpoch)) $("liveStatus").textContent = localizedFailure(error);
  }
}
async function rejectExec(taskId) {
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  try {
    await api(`/api/sessions/${requestedId}/execution/${taskId}/reject`, { method: "POST", body: "{}" });
    if (isCurrentSessionView(requestedId, requestedEpoch)) await loadSession();
  } catch (error) {
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    $("liveStatus").textContent = localizedFailure(error);
    await loadSession();
  }
}

/* ---------------- wiring ---------------- */
document.querySelectorAll(".lang-btn").forEach((b) => b.onclick = () => applyLang(b.dataset.lang));
document.querySelectorAll(".mode-btn").forEach((b) => b.onclick = () => setMode(b.dataset.mode));
$("setupToggle").onclick = toggleSetup;
$("newSessionBtn").onclick = openNewSessionModal;
$("emptyNewBtn").onclick = openNewSessionModal;
$("newSessionCreate").onclick = confirmNewSession;
$("newSessionCancel").onclick = closeNewSessionModal;
$("newSessionName").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmNewSession(); });
document.querySelectorAll(".proj-tab").forEach((b) => b.onclick = () => setProjTab(b.dataset.proj));
$("fsUp").onclick = () => fsNavigate($("fsUp").dataset.parent || "");
$("repoSearch").addEventListener("input", () => renderRepos($("repoSearch").value));
$("sendBtn").onclick = sendMessage;
$("stopBtn").onclick = async () => { if (currentSessionId) await api(`/api/sessions/${currentSessionId}/stop`, { method: "POST", body: "{}" }); };
$("exportBtn").onclick = () => { if (currentSessionId) location.href = `/api/sessions/${currentSessionId}/export`; };
$("messageInput").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendMessage(); });
$("messageInput").addEventListener("input", () => autoGrow($("messageInput")));
$("newSessionModal").addEventListener("click", (e) => { if (e.target === $("newSessionModal")) closeNewSessionModal(); });
$("connFooter").onclick = () => { pollHealth(); if (currentSessionId) openSession(currentSessionId); };
$("openOnboard").onclick = openOnboard;
$("onboardRefresh").onclick = loadOnboard;
$("onboardDone").onclick = closeOnboard;
$("onboardModal").addEventListener("click", (e) => { if (e.target === $("onboardModal")) closeOnboard(); });
$("execToggle").onclick = toggleExec;
$("execExecutor").onchange = syncExecModes;
$("attachProject").onclick = attachProject;
$("trustProject").onclick = trustProject;
$("execRun").onclick = requestExec;
$("execStopBtn").onclick = async () => { if (currentSessionId) await api(`/api/sessions/${currentSessionId}/exec-stop`, { method: "POST", body: "{}" }); };
$("approveGo").onclick = confirmExec;
$("approveCancel").onclick = cancelExecApproval;
$("approveModal").addEventListener("click", (e) => { if (e.target === $("approveModal")) cancelExecApproval(); });

async function initialize() {
  applyLang(localStorage.getItem("agent-room-lang") || "ar");
  try {
    await loadProviderCatalog();
    loadSettings();
    syncExecModes();
    updateSetupSummary();
  } catch (error) {
    setConnected(false);
    $("connText").textContent = localizedFailure(error);
  }
  refreshSessions();
  pollHealth();
  setInterval(pollHealth, 10000);
  if (!localStorage.getItem("agent-room-onboarded")) openOnboard();
}
initialize();
