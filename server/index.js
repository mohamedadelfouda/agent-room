import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { listSessions, createSession, getSession, rootPath } from "./store.js";
import { checkCommand, runProcess } from "./process.js";
import { discoverCodexModels } from "./adapters/codex.js";
import { runOrchestration, stopRun, isRunning, abortAllRuns } from "./orchestrator.js";
import { runExecuteAndReview, acceptExecution, rejectExecution, isExecuting, stopExec } from "./exec-orchestrator.js";
import { isGitRepo, hasRemote } from "./worktree.js";
import { logInfo, logError, logPath } from "./logger.js";
import { hostAllowed, checkApiAuth, issueCookieHeader, securityHeaders } from "./security.js";

// First-run detection: are the CLIs installed + is GitHub authed? Uses shell-aware runners
// so Windows .cmd shims (like codex.cmd) resolve correctly.
async function detectAgents() {
  const [claude, codex] = await Promise.all([checkCommand("claude"), checkCommand("codex")]);
  let github = { authed: false, detail: "" };
  try {
    const r = await runProcess({ command: "gh", args: ["auth", "status"], timeoutMs: 9000 });
    const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/);
    github = { authed: r.code === 0, detail: (lines.find((l) => /Logged in|account/i.test(l)) || lines.find((l) => l.trim()) || "").trim().slice(0, 100) };
  } catch (e) { github = { authed: false, detail: String(e.message).slice(0, 100) }; }
  return {
    claude: { installed: claude.ok, version: claude.version, detail: claude.detail },
    codex: { installed: codex.ok, version: codex.version, detail: codex.detail },
    github,
  };
}

// List the user's GitHub repos (so they pick instead of pasting a URL).
async function ghRepos() {
  const r = await runProcess({ command: "gh", args: ["repo", "list", "--limit", "100", "--json", "nameWithOwner,url,visibility,updatedAt"], timeoutMs: 15000 });
  if (r.code !== 0) throw new Error((r.stderr || "gh repo list failed").split(/\r?\n/)[0]);
  return JSON.parse(r.stdout || "[]");
}
// Clone a chosen repo into a local projects folder, return its path.
async function ghClone(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repo name");
  const base = path.join(os.homedir(), "AgentRoomProjects");
  await fs.mkdir(base, { recursive: true });
  const name = repo.split("/").pop().replace(/\.git$/, "");
  const dest = path.join(base, name);
  try { await fs.access(dest); return { path: dest, existed: true }; } catch {}
  const r = await runProcess({ command: "gh", args: ["repo", "clone", repo, dest], timeoutMs: 180000 });
  if (r.code !== 0) throw new Error((r.stderr || "clone failed").split(/\r?\n/).slice(-2).join(" "));
  return { path: dest, existed: false };
}
// Server-side folder browser (no manual path typing). Empty path => drives on Windows.
async function listDirs(p) {
  if (!p) {
    const drives = [];
    for (const L of "CDEFGABHIJKLMNOPQRSTUVWXYZ") { try { await fs.access(`${L}:\\`); drives.push({ name: `${L}:\\`, path: `${L}:\\` }); } catch {} }
    return { path: "", parent: null, dirs: drives, isGit: false };
  }
  const entries = await fs.readdir(p, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => ({ name: e.name, path: path.join(p, e.name) })).sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(p);
  return { path: p, parent: parent === p ? "" : parent, dirs, isGit: await isGitRepo(p) };
}
// Update a CLI from inside the tool (claude update / codex update).
async function updateAgent(agent) {
  const cmd = agent === "claude" ? "claude" : agent === "codex" ? "codex" : null;
  if (!cmd) throw new Error("Unknown agent");
  const r = await runProcess({ command: cmd, args: ["update"], timeoutMs: 240000 });
  const out = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
  return { ok: r.code === 0, output: out.slice(0, 900) };
}

let shuttingDown = false;
async function gracefulShutdown(reason, error) {
  if (shuttingDown) return;
  shuttingDown = true;
  logError(`graceful shutdown (${reason})`, error?.stack || (error ? String(error) : ""));
  try { await abortAllRuns(reason); } catch (e) { logError("abortAllRuns failed during shutdown", String(e)); }
  try { server.close(); } catch {}
  setTimeout(() => process.exit(1), 1500).unref();
}

// An uncaught exception leaves the process in an undefined state: log, stop accepting work,
// mark in-flight runs interrupted, then shut down cleanly (don't pretend nothing happened).
process.on("uncaughtException", (error) => gracefulShutdown("uncaughtException", error));
// Rejections are logged and classified, but do not force a crash on their own.
process.on("unhandledRejection", (reason) => logError("unhandledRejection (logged, not fatal)", reason?.stack || String(reason)));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT || 3210);
const clients = new Map();

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders() });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function emit(sessionId, event) {
  const payload = `data: ${JSON.stringify({ ...event, at: new Date().toISOString() })}\n\n`;
  for (const res of clients.get(sessionId) ?? []) {
    try { res.write(payload); } catch {}
  }
}

function addSseClient(sessionId, req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...securityHeaders(),
  });
  res.write(`data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`);
  const set = clients.get(sessionId) ?? new Set();
  set.add(res);
  clients.set(sessionId, set);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) clients.delete(sessionId);
  });
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" })[ext] || "application/octet-stream";
}

async function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  try {
    const data = await fs.readFile(filePath);
    const headers = { "Content-Type": `${mimeType(filePath)}; charset=utf-8`, "Cache-Control": "no-store", ...securityHeaders() };
    // The HTML page carries the session cookie that authorizes subsequent /api calls.
    if (requested === "/index.html") headers["Set-Cookie"] = issueCookieHeader();
    res.writeHead(200, headers);
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function sessionMarkdown(session) {
  const out = [`# ${session.title}`, "", `- Status: ${session.status}`, `- Mode: ${session.mode}`, `- Updated: ${session.updatedAt}`, "", "---", ""];
  for (const message of session.messages ?? []) {
    const who = message.author === "user" ? "User" : message.author === "system" ? "System" : `${message.agent === "codex" ? "Codex" : "Claude"}${message.role ? ` — ${message.role}` : ""}`;
    out.push(`## ${who}`, "", message.content || "", "");
  }
  return out.join("\n");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    // Global host allowlist (DNS-rebinding defense) — reject before any routing or body read.
    if (!hostAllowed(req.headers.host, PORT)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders() });
      return res.end("Forbidden host");
    }
    // Every /api/* route requires the per-run session token (cookie or header),
    // plus a matching Origin for state-changing methods. The page itself (served
    // statically) needs no token — it's what delivers the cookie.
    if (parts[0] === "api") {
      const auth = checkApiAuth(req, PORT);
      if (!auth.ok) return json(res, auth.status, { error: auth.error });
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, node: process.version, platform: process.platform });
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return json(res, 200, await listSessions());
    }
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(req);
      return json(res, 201, await createSession(body.title));
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && req.method === "GET" && parts.length === 3) {
      const session = await getSession(parts[2]);
      session.running = isRunning(parts[2]);
      session.executing = isExecuting(parts[2]);
      return json(res, 200, session);
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "events" && req.method === "GET") {
      return addSseClient(parts[2], req, res);
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "message" && req.method === "POST") {
      if (shuttingDown) return json(res, 503, { error: "Server is shutting down" });
      const body = await readJson(req);
      if (isRunning(parts[2])) return json(res, 409, { error: "Session is already running" });
      runOrchestration(parts[2], body, (event) => emit(parts[2], event));
      return json(res, 202, { ok: true });
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "stop" && req.method === "POST") {
      return json(res, 200, { stopped: stopRun(parts[2]) });
    }
    // ---- Execution layer ----
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "project" && req.method === "POST") {
      const body = await readJson(req);
      const projectPath = String(body.path || "").trim();
      if (!projectPath) return json(res, 400, { error: "Project path is required" });
      let stat; try { stat = await fs.stat(projectPath); } catch { return json(res, 400, { error: "المسار غير موجود" }); }
      if (!stat.isDirectory()) return json(res, 400, { error: "المسار مش مجلد" });
      const git = await isGitRepo(projectPath);
      const session = await getSession(parts[2]);
      session.project = { path: projectPath, isGit: git, hasRemote: git ? await hasRemote(projectPath) : false };
      const { saveSession } = await import("./store.js");
      await saveSession(session);
      return json(res, 200, { project: session.project });
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "execute" && req.method === "POST") {
      if (shuttingDown) return json(res, 503, { error: "Server is shutting down" });
      if (isExecuting(parts[2]) || isRunning(parts[2])) return json(res, 409, { error: "السيشن مشغولة بالفعل" });
      const body = await readJson(req);
      runExecuteAndReview(parts[2], body, (event) => emit(parts[2], event));
      return json(res, 202, { ok: true });
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "exec-stop" && req.method === "POST") {
      return json(res, 200, { stopped: stopExec(parts[2]) });
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "execution" && parts[4] && parts[5] === "accept" && req.method === "POST") {
      const body = await readJson(req);
      try { return json(res, 200, await acceptExecution(parts[2], parts[4], body.action || "merge")); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "execution" && parts[4] && parts[5] === "reject" && req.method === "POST") {
      try { return json(res, 200, await rejectExecution(parts[2], parts[4])); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/agents/status") {
      return json(res, 200, await detectAgents());
    }
    if (req.method === "POST" && url.pathname === "/api/agents/update") {
      const body = await readJson(req);
      try { return json(res, 200, await updateAgent(String(body.agent || ""))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/github/repos") {
      try { return json(res, 200, { repos: await ghRepos() }); }
      catch (e) { return json(res, 200, { repos: [], error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/github/clone") {
      const body = await readJson(req);
      try { return json(res, 200, await ghClone(String(body.repo || ""))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/fs/list") {
      try { return json(res, 200, await listDirs(url.searchParams.get("path") || "")); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "export" && req.method === "GET") {
      const session = await getSession(parts[2]);
      const md = sessionMarkdown(session);
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename=\"agent-room-${session.id}.md\"`,
        ...securityHeaders(),
      });
      return res.end(md);
    }
    if (req.method === "POST" && url.pathname === "/api/cli/check") {
      const body = await readJson(req);
      return json(res, 200, await checkCommand(body.command));
    }
    if (req.method === "POST" && url.pathname === "/api/codex/models") {
      const body = await readJson(req);
      try {
        return json(res, 200, { models: await discoverCodexModels({ command: body.command }) });
      } catch (error) {
        return json(res, 200, { models: [], warning: error.message });
      }
    }
    if (await serveStatic(url.pathname, res)) return;
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\nAgent Room MVP is running at ${url}\nData folder: ${path.join(rootPath(), "data")}\n`);
  if (process.env.NO_OPEN !== "1") {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try { spawn(command, args, { detached: true, stdio: "ignore" }).unref(); } catch {}
  }
});
