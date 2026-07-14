import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let origin;
let cookie;
let sessionId;
let runtimeDir;
let projectDir;
let shutdownServer;
let mutateSession;

async function post(pathname, body) {
  return fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin },
    body: JSON.stringify(body),
  });
}

before(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-api-errors-"));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-api-project-"));
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  process.env.AGENT_ROOM_RUNTIME_DIR = runtimeDir;
  process.env.NO_OPEN = "1";
  process.env.PORT = "0";
  const serverModule = await import("../../server/index.js");
  ({ mutateSession } = await import("../../server/store.js"));
  ({ url: origin } = await serverModule.serverReady);
  shutdownServer = serverModule.shutdownServer;

  const landing = await fetch(origin);
  cookie = landing.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const created = await post("/api/sessions", { title: "Error contract" });
  assert.equal(created.status, 201);
  sessionId = (await created.json()).id;
});

after(async () => {
  await shutdownServer?.("api_error_contract_test");
  await fs.rm(runtimeDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

test("project validation keeps the legacy message and exposes a stable code", async () => {
  const response = await post(`/api/sessions/${sessionId}/project`, { path: "" });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.code, "project_path_required");
  assert.equal(payload.error, "Project path is required");
  assert.equal(payload.detail, payload.error);
});

test("route rejection exposes the same reason code in the error and route", async () => {
  const response = await post(`/api/sessions/${sessionId}/message`, { content: "run the tests" });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.code, "state_change_requires_execution");
  assert.equal(payload.route.reasonCode, payload.code);
  assert.equal(payload.detail, payload.error);
});

test("pending execution conflict returns 409 with a stable code", async () => {
  const attached = await post(`/api/sessions/${sessionId}/project`, { path: projectDir });
  assert.equal(attached.status, 200);
  await mutateSession(sessionId, (session) => {
    session.executions = [{ taskId: "pending", status: "awaiting_user" }];
  });

  const response = await post(`/api/sessions/${sessionId}/project`, { path: projectDir });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.code, "pending_execution_decisions");
  assert.equal(payload.detail, payload.error);
});
