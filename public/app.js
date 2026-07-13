const $ = (id) => document.getElementById(id);

let currentSessionId = null;
let currentSession = null;
let eventSource = null;
let mode = "collaboration";
let running = false;
let lang = "ar";

const settingsIds = ["codexCommand","codexModel","codexEffort","codexRole","codexEnabled","claudeCommand","claudeModel","claudeEffort","claudeRole","claudeEnabled","rounds","finalizer"];

/* ---------------- i18n ---------------- */
const STRINGS = {
  ar: {
    newSession:"جلسة جديدة", sessions:"الجلسات", connected:"متصل", disconnected:"غير متصل — اضغط لإعادة المحاولة",
    emptyTitle:"جلسة واحدة، أكثر من عقل", emptyBody:"أنشئ جلسة، اختر التعاون أو المناظرة، وحدّد الموديل والـeffort لكل وكيل. أنت صاحب القرار.",
    mode:"أسلوب الجولة", modeCollab:"تعاون", modeDebate:"Debate", modeChat:"شات", rounds:"عدد الجولات", roundsShort:"جولات", finalizer:"الخلاصة النهائية", none:"بدون",
    command:"Command", role:"الدور", check:"فحص", load:"تحميل", notChecked:"لم يتم الفحص", ready:"جاهز", export:"تصدير", stop:"إيقاف",
    send:"ابدأ الجولة", composerPh:"اكتب الفكرة أو السؤال...", namePh:"مثال: تطوير التحليل المالي", nameLabel:"اسم الجلسة",
    firstLabel:"الموضوع أو أول رسالة (اختياري)", newSessionTitle:"جلسة جديدة", cancel:"إلغاء", create:"إنشاء",
    you:"أنت", system:"النظام", partialTag:"رد جزئي — فشل", roundWord:"جولة", messagesWord:"رسالة", contextWord:"سياق", techDetails:"عرض التفاصيل التقنية",
    writeFirst:"اكتب الفكرة أو السؤال أولًا", starting:"بدء الجولة...", runDone:"اكتملت الجولة", runStopped:"تم الإيقاف",
    working:(a)=>`${a} يعمل الآن...`, replied:"اكتمل الرد",
    execute:"تنفيذ", projectLabel:"مجلد المشروع (git)", attach:"ربط", executor:"المنفّذ", reviewer:"المراجع",
    permMode:"وضع الصلاحية", modeEdit:"تعديل ملفات", modeRun:"تعديل + تشغيل أوامر", modeFull:"كامل + push/PR",
    execTaskLabel:"المهمة للمنفّذ", execTaskPh:"اكتب المهمة اللي المنفّذ ينفّذها في المشروع...", reviewRun:"راجِع ونفّذ",
    onboardTitle:"توصيل الوكلاء", onboardSub:"دي حالة أدواتك المحلية. لو كلها خضراء إنت جاهز.", recheck:"إعادة الفحص", start:"ابدأ",
    approveTitle:"اعتماد التنفيذ", approveGo:"اعتمد ونفّذ",
    execExecuting:(a)=>`${a} بينفّذ في worktree...`, execReviewing:(a)=>`${a} بيراجع (قراءة فقط)...`, execAwaiting:"خلص — بانتظار قرارك",
    mergeLocal:"دمج محلي", openPr:"افتح PR", reject:"رفض", attached:"مربوط", notGit:"مش git repo", sameAgent:"المنفّذ والمراجع لازم مختلفين",
    workLocation:"مكان الشغل (اختياري)", projNone:"بدون", projLocal:"فولدر لوكال", projGithub:"GitHub",
    repoSearchPh:"ابحث في ريبوهاتك...", useFolder:"استخدم", update:"تحديث", updating:"جاري التحديث...", cloning:"جاري استنساخ الريبو...", noRepos:"مفيش ريبوهات", noFolders:"مفيش مجلدات",
  },
  en: {
    newSession:"New session", sessions:"Sessions", connected:"Connected", disconnected:"Disconnected — click to retry",
    emptyTitle:"One session, many minds", emptyBody:"Create a session, choose Collaboration or Debate, set model and effort per agent. You decide.",
    mode:"Mode", modeCollab:"Collaborate", modeDebate:"Debate", modeChat:"Chat", rounds:"Rounds", roundsShort:"rounds", finalizer:"Final synthesis", none:"None",
    command:"Command", role:"Role", check:"Check", load:"Load", notChecked:"Not checked", ready:"Ready", export:"Export", stop:"Stop",
    send:"Start round", composerPh:"Type your idea or question...", namePh:"e.g. Financial analysis feature", nameLabel:"Session name",
    firstLabel:"Topic or first message (optional)", newSessionTitle:"New session", cancel:"Cancel", create:"Create",
    you:"You", system:"System", partialTag:"Partial — failed", roundWord:"Round", messagesWord:"msg", contextWord:"context", techDetails:"View technical details",
    writeFirst:"Type your idea or question first", starting:"Starting round...", runDone:"Round complete", runStopped:"Stopped",
    working:(a)=>`${a} is working...`, replied:"Reply complete",
    execute:"Execute", projectLabel:"Project folder (git)", attach:"Attach", executor:"Executor", reviewer:"Reviewer",
    permMode:"Permission mode", modeEdit:"Edit files", modeRun:"Edit + run commands", modeFull:"Full + push/PR",
    execTaskLabel:"Task for the executor", execTaskPh:"Describe what the executor should do in the project...", reviewRun:"Review & execute",
    onboardTitle:"Connect your agents", onboardSub:"Your local tools. If all green, you're ready.", recheck:"Re-check", start:"Start",
    approveTitle:"Approve execution", approveGo:"Approve & run",
    execExecuting:(a)=>`${a} is executing in a worktree...`, execReviewing:(a)=>`${a} is reviewing (read-only)...`, execAwaiting:"Done — awaiting your decision",
    mergeLocal:"Merge locally", openPr:"Open PR", reject:"Reject", attached:"Attached", notGit:"not a git repo", sameAgent:"Executor and reviewer must differ",
    workLocation:"Work location (optional)", projNone:"None", projLocal:"Local folder", projGithub:"GitHub",
    repoSearchPh:"Search your repos...", useFolder:"Use", update:"Update", updating:"Updating...", cloning:"Cloning repo...", noRepos:"No repos", noFolders:"No folders",
  },
};
const t = (key) => STRINGS[lang][key];

function applyLang(next) {
  lang = STRINGS[next] ? next : "ar";
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach((el) => { const k = el.getAttribute("data-i18n"); if (STRINGS[lang][k]) el.textContent = t(k); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { const k = el.getAttribute("data-i18n-ph"); if (STRINGS[lang][k]) el.placeholder = t(k); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { const k = el.getAttribute("data-i18n-title"); if (STRINGS[lang][k]) el.title = t(k); });
  document.querySelectorAll(".lang-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.lang === lang));
  setConnected(!$("serverStatus").classList.contains("is-bad") ? true : false);
  updateSetupSummary();
  refreshSessions();
  if (currentSession) { loadSessionMeta(); renderMessages(); }
  localStorage.setItem("agent-room-lang", lang);
}

/* ---------------- settings ---------------- */
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("agent-room-settings") || "{}");
    for (const id of settingsIds) {
      const el = $(id); if (!el || !(id in saved)) continue;
      if (el.type === "checkbox") el.checked = Boolean(saved[id]); else el.value = saved[id];
    }
    if (saved.mode) setMode(saved.mode, true);
  } catch {}
}
function saveSettings() {
  const saved = { mode };
  for (const id of settingsIds) { const el = $(id); if (!el) continue; saved[id] = el.type === "checkbox" ? el.checked : el.value; }
  localStorage.setItem("agent-room-settings", JSON.stringify(saved));
}

/* ---------------- api ---------------- */
async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json; charset=utf-8", ...(options.headers || {}) }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- mode + setup drawer ---------------- */
function setMode(next, silent) {
  mode = next === "debate" ? "debate" : next === "chat" ? "chat" : "collaboration";
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === mode));
  if (mode === "debate") {
    if ($("codexRole").value === "شريك في الحل") $("codexRole").value = "الموقف الثاني / المعارض";
    if ($("claudeRole").value === "شريك في الحل") $("claudeRole").value = "الموقف الأول / المؤيد";
  }
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
}
function updateSetupSummary() {
  const parts = [];
  if ($("claudeEnabled").checked) parts.push("Claude");
  if ($("codexEnabled").checked) parts.push("Codex");
  const modeLabel = mode === "debate" ? "Debate" : mode === "chat" ? t("modeChat") : t("modeCollab");
  const roundsPart = mode === "chat" ? "" : ` · ${$("rounds").value} ${t("roundsShort")}`;
  $("setupSummary").textContent = `${modeLabel} · ${parts.join(" + ") || "—"}${roundsPart}`;
}

/* ---------------- sessions rail ---------------- */
async function refreshSessions() {
  let sessions = [];
  try { sessions = await api("/api/sessions"); } catch { return; }
  const list = $("sessionList");
  list.innerHTML = "";
  for (const s of sessions) {
    const btn = document.createElement("button");
    btn.className = `session-item ${s.id === currentSessionId ? "is-active" : ""}`;
    const title = document.createElement("div"); title.className = "si-title"; title.textContent = s.title;
    const sub = document.createElement("div"); sub.className = "si-sub";
    const dot = document.createElement("span"); dot.className = `si-dot ${s.status || ""}`;
    const meta = document.createElement("span"); meta.textContent = `${s.mode || "idle"} · ${s.messageCount} ${t("messagesWord")}`;
    sub.append(dot, meta); btn.append(title, sub);
    btn.onclick = () => openSession(s.id);
    list.appendChild(btn);
  }
}

/* ---------------- session open / focused view ---------------- */
async function openSession(id) {
  currentSessionId = id;
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/sessions/${id}/events`);
  eventSource.onmessage = (e) => handleEvent(JSON.parse(e.data));
  eventSource.onopen = () => setConnected(true);
  eventSource.onerror = () => setConnected(false);
  $("emptyState").hidden = true;
  $("sessionView").hidden = false;
  await loadSession();
  await refreshSessions();
}

async function loadSession() {
  if (!currentSessionId) return;
  currentSession = await api(`/api/sessions/${currentSessionId}`);
  running = Boolean(currentSession.running || currentSession.status === "running");
  loadSessionMeta();
  $("messageInput").disabled = running;
  $("sendBtn").disabled = running;
  $("stopBtn").disabled = !running;
  $("exportBtn").disabled = false;
  if (currentSession.project?.path) {
    $("projectPath").value = currentSession.project.path;
    $("projectStatus").textContent = `${t("attached")}: ${currentSession.project.path}`;
    $("projectStatus").className = "run-state done";
  }
  renderMessages();
}
function loadSessionMeta() {
  if (!currentSession) return;
  $("sessionTitle").textContent = currentSession.title;
  $("sessionMeta").textContent = `${currentSession.mode || "idle"} · ${currentSession.messages.length} ${t("messagesWord")} · ${currentSession.status}`;
}

/* ---------------- messages ---------------- */
function esc(text) {
  return String(text ?? "").replace(/[&<>'"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;" }[c]));
}
function fmtDuration(ms) {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
function renderMessages() {
  const chat = $("chat");
  chat.innerHTML = "";
  for (const msg of currentSession?.messages ?? []) {
    const meta = msg.meta || {};
    const isPartial = meta.status === "partial";
    const isError = meta.status === "error";
    const el = document.createElement("article");
    el.className = `msg msg-${msg.author}${isPartial ? " msg-partial" : ""}${isError ? " msg-error" : ""}`;
    const time = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString(lang === "ar" ? "ar-EG" : "en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
    const techHtml = meta.technical ? `<details class="tech"><summary>${t("techDetails")}</summary><pre>${esc(String(meta.technical).slice(0, 8000))}</pre></details>` : "";

    if (msg.author === "agent") {
      const isCodex = msg.agent === "codex";
      const name = isCodex ? "Codex" : "Claude";
      const badges = [msg.role, msg.phase, msg.round ? `${t("roundWord")} ${msg.round}` : "", isPartial ? t("partialTag") : ""]
        .filter(Boolean)
        .map((b) => `<span class="badge${isPartial && b === t("partialTag") ? " badge-partial" : ""}">${esc(b)}</span>`).join("");
      const metaParts = [meta.requestedModel, meta.requestedEffort, fmtDuration(meta.durationMs)].filter(Boolean);
      const ctx = meta.contextChars ? ` · ${t("contextWord")} ${meta.contextChars}` : "";
      const footer = metaParts.length ? `<div class="msg-meta">${esc(metaParts.join(" · "))}${ctx}</div>` : "";
      el.innerHTML =
        `<div class="msg-head"><span class="agent-avatar ${isCodex ? "codex" : "claude"}">${isCodex ? "C" : "A"}</span>` +
        `<span class="msg-name">${name}</span>${badges}<span class="msg-time">${time}</span></div>` +
        `<div class="msg-body"><div class="msg-content">${esc(msg.content)}</div>${footer}${techHtml}</div>`;
    } else if (msg.author === "user") {
      el.innerHTML = `<div class="msg-body"><div class="msg-content">${esc(msg.content)}</div></div>`;
    } else {
      el.innerHTML = `<div class="msg-body">${esc(msg.content)}</div>${techHtml}`;
    }
    chat.appendChild(el);
  }
  renderExecutions();
  // Completed sessions open at the first message (read from the top); live runs follow the newest.
  chat.scrollTop = running ? chat.scrollHeight : 0;
}
function autoGrow(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 200) + "px"; }

/* ---------------- SSE ---------------- */
function handleEvent(event) {
  if (event.type === "session_updated") loadSession();
  if (event.type === "run_started") setRunning(true, `${event.mode} · ${event.rounds}`);
  if (event.type === "agent_start") { setAgentState(event.agent, `${event.phase} · ${t("roundWord")} ${event.round}`, "running"); $("liveStatus").textContent = t("working")(event.label); }
  if (event.type === "agent_activity" && event.event?.text) setAgentState(event.agent, event.event.text.slice(0, 90), "running");
  if (event.type === "agent_complete") setAgentState(event.agent, t("replied"), "done");
  if (["run_complete","run_stopped","run_error"].includes(event.type)) {
    setRunning(false, event.type === "run_complete" ? t("runDone") : event.type === "run_stopped" ? t("runStopped") : `${event.error || "error"}`);
    loadSession(); refreshSessions();
  }
  if (event.type === "exec_started") setRunning(true, t("starting"));
  if (event.type === "exec_phase") { const s = event.phase === "executing" ? t("execExecuting")(event.agent) : t("execReviewing")(event.agent); $("execStatus").textContent = s; $("liveStatus").textContent = s; }
  if (event.type === "exec_ready") { setRunning(false, t("execAwaiting")); $("execStopBtn").hidden = true; $("execRun").disabled = false; $("execTask").value = ""; loadSession(); refreshSessions(); }
  if (event.type === "exec_error") { setRunning(false, event.error); $("execStopBtn").hidden = true; $("execRun").disabled = false; }
}
function setAgentState(agent, text, cls = "") { const el = $(`${agent}RunState`); if (el) { el.textContent = text; el.className = `run-state ${cls}`; } }
function setRunning(value, status) {
  running = value;
  $("messageInput").disabled = value || !currentSessionId;
  $("sendBtn").disabled = value || !currentSessionId;
  $("stopBtn").disabled = !value;
  if (status) $("liveStatus").textContent = status;
}

/* ---------------- send ---------------- */
function payload() {
  return {
    content: $("messageInput").value.trim(), mode, rounds: Number($("rounds").value), finalizer: $("finalizer").value,
    agents: {
      codex: { enabled: $("codexEnabled").checked, command: $("codexCommand").value.trim(), model: $("codexModel").value.trim(), effort: $("codexEffort").value, role: $("codexRole").value.trim() },
      claude: { enabled: $("claudeEnabled").checked, command: $("claudeCommand").value.trim(), model: $("claudeModel").value, effort: $("claudeEffort").value, role: $("claudeRole").value.trim() },
    },
  };
}
async function sendMessage() {
  if (!currentSessionId || running) return;
  const body = payload();
  if (!body.content) { $("liveStatus").textContent = t("writeFirst"); return; }
  saveSettings();
  setRunning(true, t("starting"));
  try {
    await api(`/api/sessions/${currentSessionId}/message`, { method: "POST", body: JSON.stringify(body) });
    $("messageInput").value = "";
    autoGrow($("messageInput"));
  } catch (error) { setRunning(false, error.message); }
}

/* ---------------- cli check / models ---------------- */
async function checkCli(agent) {
  const command = $(`${agent}Command`).value.trim();
  const health = $(`${agent}Health`);
  health.textContent = "..."; health.className = "health";
  try {
    const result = await api("/api/cli/check", { method: "POST", body: JSON.stringify({ command }) });
    health.textContent = result.ok ? result.version : result.detail;
    health.className = `health ${result.ok ? "ok" : "bad"}`;
  } catch (error) { health.textContent = error.message; health.className = "health bad"; }
}
async function loadCodexModels() {
  const btn = $("loadCodexModels"); btn.disabled = true; const old = btn.textContent; btn.textContent = "...";
  try {
    const result = await api("/api/codex/models", { method: "POST", body: JSON.stringify({ command: $("codexCommand").value.trim() }) });
    const list = $("codexModels"); list.innerHTML = "";
    for (const m of result.models) { const o = document.createElement("option"); o.value = m; list.appendChild(o); }
  } catch {}
  finally { btn.disabled = false; btn.textContent = old; }
}

/* ---------------- new session modal ---------------- */
function openNewSessionModal() {
  $("newSessionName").value = ""; $("newSessionFirst").value = "";
  chosenProject = null; $("projChosen").classList.add("hidden");
  $("fsList").dataset.loaded = ""; $("repoList").dataset.loaded = ""; if ($("repoSearch")) $("repoSearch").value = "";
  setProjTab("none");
  hideModalError();
  $("newSessionModal").classList.remove("hidden"); $("newSessionName").focus();
}
function closeNewSessionModal() { $("newSessionModal").classList.add("hidden"); }
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
    if (first) { $("messageInput").value = first; $("messageInput").focus(); }
  } catch (error) { showModalError(error.message); }
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
      { name: "Claude Code", ok: s.claude.installed, detail: s.claude.version || s.claude.detail, agent: "claude" },
      { name: "Codex CLI", ok: s.codex.installed, detail: s.codex.version || s.codex.detail, agent: "codex" },
      { name: "GitHub (gh)", ok: s.github.authed, detail: s.github.detail, agent: null },
    ];
    for (const r of rows) {
      const row = document.createElement("div"); row.className = "onboard-row";
      row.innerHTML = `<span class="onboard-dot ${r.ok ? "ok" : "bad"}"></span><span class="ob-name">${esc(r.name)}</span><span class="ob-detail">${esc(r.detail || "")}</span>`;
      if (r.agent) {
        const actions = document.createElement("span"); actions.className = "ob-actions";
        const btn = document.createElement("button"); btn.className = "btn-mini"; btn.textContent = t("update");
        btn.onclick = () => updateAgentCli(r.agent, btn);
        actions.appendChild(btn); row.appendChild(actions);
      }
      list.appendChild(row);
    }
  } catch (e) { list.textContent = e.message; }
}
async function updateAgentCli(agent, btn) {
  btn.disabled = true; btn.textContent = t("updating");
  try {
    const r = await api("/api/agents/update", { method: "POST", body: JSON.stringify({ agent }) });
    btn.textContent = r.ok ? "✓" : "!";
    setTimeout(loadOnboard, 1000);
  } catch (e) { btn.textContent = "!"; btn.title = e.message; btn.disabled = false; }
}

/* project picker (new-session modal) */
let projMode = "none";
let chosenProject = null;
let repoCache = [];
function setProjTab(mode) {
  projMode = mode;
  document.querySelectorAll(".proj-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.proj === mode));
  $("projLocalPane").hidden = mode !== "local";
  $("projGithubPane").hidden = mode !== "github";
  if (mode === "none") { chosenProject = null; $("projChosen").classList.add("hidden"); }
  if (mode === "local" && $("fsList").dataset.loaded !== "1") fsNavigate("");
  if (mode === "github" && $("repoList").dataset.loaded !== "1") loadRepos();
}
function showChosen(text) { const el = $("projChosen"); el.textContent = "✓ " + text; el.classList.remove("hidden"); }
async function fsNavigate(p) {
  const list = $("fsList"); list.innerHTML = `<div class="fs-empty">…</div>`;
  try {
    const r = await api(`/api/fs/list?path=${encodeURIComponent(p)}`);
    list.dataset.loaded = "1";
    $("fsPath").textContent = r.path || "—";
    $("fsUp").dataset.parent = r.parent ?? "";
    $("fsUp").disabled = r.parent === null;
    list.innerHTML = "";
    if (r.path) {
      const cur = document.createElement("div"); cur.className = "fs-item";
      cur.innerHTML = `${r.isGit ? '<span class="fs-git">git</span>' : '<span class="fs-ic">📂</span>'}<span class="fs-name">${esc(t("useFolder"))} ← ${esc(r.path)}</span><button class="fs-use">${esc(t("useFolder"))}</button>`;
      cur.querySelector(".fs-use").onclick = () => { chosenProject = { type: "local", path: r.path }; showChosen("📁 " + r.path); };
      list.appendChild(cur);
    }
    for (const d of r.dirs) {
      const row = document.createElement("div"); row.className = "fs-item";
      row.innerHTML = `<span class="fs-ic">📁</span><span class="fs-name">${esc(d.name)}</span>`;
      row.querySelector(".fs-name").onclick = () => fsNavigate(d.path);
      list.appendChild(row);
    }
    if (!r.dirs.length && !r.path) list.innerHTML = `<div class="fs-empty">${esc(t("noFolders"))}</div>`;
  } catch (e) { list.innerHTML = `<div class="fs-empty">${esc(e.message)}</div>`; }
}
async function loadRepos() {
  const list = $("repoList"); list.innerHTML = `<div class="fs-empty">…</div>`;
  try {
    const r = await api("/api/github/repos");
    list.dataset.loaded = "1";
    repoCache = r.repos || [];
    renderRepos("");
  } catch (e) { list.innerHTML = `<div class="fs-empty">${esc(e.message)}</div>`; }
}
function renderRepos(q) {
  const list = $("repoList"); list.innerHTML = "";
  const repos = repoCache.filter((r) => r.nameWithOwner.toLowerCase().includes(q.toLowerCase()));
  if (!repos.length) { list.innerHTML = `<div class="fs-empty">${esc(t("noRepos"))}</div>`; return; }
  for (const r of repos.slice(0, 60)) {
    const row = document.createElement("div"); row.className = "fs-item"; row.style.cursor = "pointer";
    row.innerHTML = `<span class="fs-ic">◉</span><span class="fs-name">${esc(r.nameWithOwner)}</span><span class="repo-vis">${esc(r.visibility)}</span>`;
    row.onclick = () => { chosenProject = { type: "github", repo: r.nameWithOwner }; showChosen("◉ " + r.nameWithOwner); };
    list.appendChild(row);
  }
}
function openOnboard() { $("onboardModal").classList.remove("hidden"); loadOnboard(); }
function closeOnboard() { $("onboardModal").classList.add("hidden"); localStorage.setItem("agent-room-onboarded", "1"); }

/* ---------------- project + execute ---------------- */
function toggleExec() { const d = $("execDrawer"); d.hidden = !d.hidden; if (!d.hidden) { $("setupDrawer").hidden = true; $("setupToggle").setAttribute("aria-expanded", "false"); } }
async function attachProject() {
  const p = $("projectPath").value.trim(); if (!p || !currentSessionId) return;
  const st = $("projectStatus"); st.textContent = "..."; st.className = "run-state";
  try {
    const r = await api(`/api/sessions/${currentSessionId}/project`, { method: "POST", body: JSON.stringify({ path: p }) });
    st.textContent = `${t("attached")}: ${r.project.path}${r.project.isGit ? "" : " (" + t("notGit") + ")"}`;
    st.className = "run-state " + (r.project.isGit ? "done" : "");
    if (currentSession) currentSession.project = r.project;
  } catch (e) { st.textContent = e.message; }
}
function execPayload() {
  return {
    executor: $("execExecutor").value, reviewer: $("execReviewer").value, mode: $("execMode").value, task: $("execTask").value.trim(),
    agents: {
      codex: { command: $("codexCommand").value.trim(), model: $("codexModel").value.trim(), effort: $("codexEffort").value },
      claude: { command: $("claudeCommand").value.trim(), model: $("claudeModel").value, effort: $("claudeEffort").value },
    },
  };
}
let pendingExec = null;
function requestExec() {
  if (!currentSessionId || running) return;
  const body = execPayload();
  if (!body.task) { $("execStatus").textContent = t("writeFirst"); return; }
  if (body.executor === body.reviewer) { $("execStatus").textContent = t("sameAgent"); return; }
  pendingExec = body;
  $("approveBody").innerHTML = `<b>${esc(body.executor)}</b> — ${esc(modeLabel(body.mode))} — worktree معزول (كتابة/تشغيل). <b>${esc(body.reviewer)}</b> يراجع (قراءة فقط).<br><br>${esc(body.task)}`;
  $("approveModal").classList.remove("hidden");
}
async function confirmExec() {
  $("approveModal").classList.add("hidden");
  if (!pendingExec) return;
  setRunning(true, t("starting")); $("execStopBtn").hidden = false; $("execRun").disabled = true;
  try { await api(`/api/sessions/${currentSessionId}/execute`, { method: "POST", body: JSON.stringify(pendingExec) }); }
  catch (e) { setRunning(false, e.message); $("execStopBtn").hidden = true; $("execRun").disabled = false; }
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
function modeLabel(m) { return { edit: t("modeEdit"), run: t("modeRun"), full: t("modeFull") }[m] || m; }
function execStatusLabel(s) { return { awaiting_user: t("execAwaiting"), merged: "merged ✓", pr_opened: "PR ✓", rejected: "rejected" }[s] || s; }
function renderExecutions() {
  const chat = $("chat");
  for (const ex of currentSession?.executions ?? []) {
    const el = document.createElement("article"); el.className = "msg exec-card";
    let body = `<div class="exec-body">`;
    body += `<div class="exec-part"><div class="exec-label">${esc(t("executor"))} (${esc(ex.executor)})</div><div class="exec-text">${esc(ex.executorText || "")}</div></div>`;
    if (ex.diff?.patch) body += `<div class="exec-part exec-diff"><div class="exec-label">${esc(ex.diff.files || "")}</div><pre>${highlightDiff(ex.diff.patch)}</pre></div>`;
    if (ex.review?.text) body += `<div class="exec-part"><div class="exec-label">${esc(t("reviewer"))} (${esc(ex.reviewer)})</div><div class="exec-text">${esc(ex.review.text)}</div></div>`;
    if (ex.status === "awaiting_user") {
      body += `<div class="exec-decision"><button class="btn-primary" data-accept="merge" data-task="${esc(ex.taskId)}">${esc(t("mergeLocal"))}</button>`;
      if (currentSession.project?.hasRemote) body += `<button class="btn-ghost" data-accept="pr" data-task="${esc(ex.taskId)}">${esc(t("openPr"))}</button>`;
      body += `<button class="btn-danger" data-reject="${esc(ex.taskId)}">${esc(t("reject"))}</button></div>`;
    } else {
      const link = ex.prUrl ? ` — <a href="${esc(ex.prUrl)}" target="_blank" rel="noopener">PR</a>` : "";
      body += `<div class="exec-status-line">${esc(execStatusLabel(ex.status))}${link}</div>`;
    }
    body += `</div>`;
    el.innerHTML = `<div class="exec-card-head"><span class="exec-badge">${esc(t("execute"))}</span> <b>${esc(ex.executor)}</b> → ${esc(ex.reviewer || "—")} <span class="badge">${esc(modeLabel(ex.mode))}</span> <span class="badge">${esc(execStatusLabel(ex.status))}</span></div>${body}`;
    chat.appendChild(el);
  }
  chat.querySelectorAll("[data-accept]").forEach((b) => b.onclick = () => acceptExec(b.dataset.task, b.dataset.accept));
  chat.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => rejectExec(b.dataset.reject));
}
async function acceptExec(taskId, action) {
  try { const r = await api(`/api/sessions/${currentSessionId}/execution/${taskId}/accept`, { method: "POST", body: JSON.stringify({ action }) }); await loadSession(); if (r.prUrl) window.open(r.prUrl, "_blank"); }
  catch (e) { $("liveStatus").textContent = e.message; }
}
async function rejectExec(taskId) {
  try { await api(`/api/sessions/${currentSessionId}/execution/${taskId}/reject`, { method: "POST", body: "{}" }); await loadSession(); }
  catch (e) { $("liveStatus").textContent = e.message; }
}

/* ---------------- wiring ---------------- */
document.querySelectorAll(".lang-btn").forEach((b) => b.onclick = () => applyLang(b.dataset.lang));
document.querySelectorAll(".mode-btn").forEach((b) => b.onclick = () => setMode(b.dataset.mode));
document.querySelectorAll(".check-cli").forEach((b) => b.onclick = () => checkCli(b.dataset.agent));
settingsIds.forEach((id) => { const el = $(id); if (el) el.addEventListener("change", () => { saveSettings(); updateSetupSummary(); }); });
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
$("loadCodexModels").onclick = loadCodexModels;
$("messageInput").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendMessage(); });
$("messageInput").addEventListener("input", () => autoGrow($("messageInput")));
$("newSessionModal").addEventListener("click", (e) => { if (e.target === $("newSessionModal")) closeNewSessionModal(); });
$("connFooter").onclick = () => { pollHealth(); if (currentSessionId) openSession(currentSessionId); };
$("openOnboard").onclick = openOnboard;
$("onboardRefresh").onclick = loadOnboard;
$("onboardDone").onclick = closeOnboard;
$("onboardModal").addEventListener("click", (e) => { if (e.target === $("onboardModal")) closeOnboard(); });
$("execToggle").onclick = toggleExec;
$("attachProject").onclick = attachProject;
$("execRun").onclick = requestExec;
$("execStopBtn").onclick = async () => { if (currentSessionId) await api(`/api/sessions/${currentSessionId}/exec-stop`, { method: "POST", body: "{}" }); };
$("approveGo").onclick = confirmExec;
$("approveCancel").onclick = () => { $("approveModal").classList.add("hidden"); pendingExec = null; };
$("approveModal").addEventListener("click", (e) => { if (e.target === $("approveModal")) { $("approveModal").classList.add("hidden"); pendingExec = null; } });

applyLang(localStorage.getItem("agent-room-lang") || "ar");
loadSettings();
refreshSessions();
pollHealth();
setInterval(pollHealth, 10000);
if (!localStorage.getItem("agent-room-onboarded")) openOnboard();
