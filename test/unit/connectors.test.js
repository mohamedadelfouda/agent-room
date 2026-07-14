import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSession, getSession, saveSession } from "../../server/store.js";
import { connectorCatalog } from "../../server/connectors/registry.js";
import { setConnectorEnabled, requestConnectorAction, decideConnectorAction } from "../../server/connectors/service.js";
import { handleMcpRequest } from "../../server/mcp-server.js";
import { claudeMcpLaunch, resolveMcpBridgeGrant, setMcpBridgeUrl } from "../../server/mcp-config.js";

const sessionsDir = join(dirname(fileURLToPath(import.meta.url)), "../../data/sessions");
const cleanup = (id) => Promise.all([
  rm(join(sessionsDir, `${id}.json`), { force: true }),
  rm(join(sessionsDir, `${id}.summary.json`), { force: true }),
]).catch(() => {});

test("connector catalog exposes read/write intent without implementation functions", () => {
  const catalog = connectorCatalog();
  assert.deepEqual(catalog.map((item) => item.id), ["github", "gmail", "supabase"]);
  assert.equal(catalog.find((item) => item.id === "gmail").actions.find((action) => action.id === "send_message").stateChanging, true);
  assert.ok(catalog.every((item) => item.actions.every((action) => !("run" in action))));
});

test("state-changing connector calls become proposals and require an explicit decision", async () => {
  const session = await createSession("connector-test");
  try {
    await setConnectorEnabled(session.id, "github", true);
    const proposal = await requestConnectorAction(session.id, "github", "create_issue", { repo: "owner/repo", title: "Title", body: "Body" });
    assert.equal(proposal.status, "pending");
    const rejected = await decideConnectorAction(session.id, proposal.id, false);
    assert.equal(rejected.status, "rejected");
    const saved = await getSession(session.id);
    assert.ok(saved.decisions.some((decision) => decision.outcome === "rejected" && decision.taskId === proposal.id));
  } finally { await cleanup(session.id); }
});

test("connector proposals reject inputs too large to review and persist safely", async () => {
  const session = await createSession("connector-size-test");
  try {
    await setConnectorEnabled(session.id, "github", true);
    await assert.rejects(
      () => requestConnectorAction(session.id, "github", "create_issue", { body: "x".repeat(70000) }),
      /64 KiB approval limit/,
    );
  } finally { await cleanup(session.id); }
});

test("Gmail send performs no network call until approval, then executes exactly once", async () => {
  const session = await createSession("gmail-approval-test");
  const previousToken = process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const payload = JSON.parse(options.body);
    assert.match(Buffer.from(payload.raw, "base64url").toString("utf8"), /To: user@example\.com/);
    return { ok: true, status: 200, json: async () => ({ id: "message-id" }) };
  };
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const proposal = await requestConnectorAction(session.id, "gmail", "send_message", { to: "user@example.com", subject: "Hello", body: "Body" });
    assert.equal(calls, 0);
    const completed = await decideConnectorAction(session.id, proposal.id, true);
    assert.equal(completed.status, "completed");
    assert.equal(calls, 1);
    await assert.rejects(() => decideConnectorAction(session.id, proposal.id, true), /already completed/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN;
    else process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("malformed success response leaves an approved connector action failed", async () => {
  const session = await createSession("gmail-malformed-response-test");
  const previousToken = process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async () => new Response("{not-json", { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const proposal = await requestConnectorAction(session.id, "gmail", "send_message", { to: "user@example.com", subject: "Hello", body: "Body" });
    await assert.rejects(() => decideConnectorAction(session.id, proposal.id, true), SyntaxError);
    const saved = await getSession(session.id);
    assert.equal(saved.connectorActions.find((item) => item.id === proposal.id).status, "failed_after_approval");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN;
    else process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("connector completion preserves session updates written during the external call", async () => {
  const session = await createSession("connector-concurrency-test");
  const previousToken = process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  let releaseFetch;
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  const release = new Promise((resolve) => { releaseFetch = resolve; });
  process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async () => {
    fetchStarted();
    await release;
    return { ok: true, status: 200, json: async () => ({ id: "message-id" }) };
  };
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const proposal = await requestConnectorAction(session.id, "gmail", "send_message", { to: "user@example.com", subject: "Hello", body: "Body" });
    const decision = decideConnectorAction(session.id, proposal.id, true);
    await started;
    const concurrent = await getSession(session.id);
    concurrent.messages.push({ role: "user", content: "written while connector was running" });
    await saveSession(concurrent);
    releaseFetch();
    await decision;
    const saved = await getSession(session.id);
    assert.ok(saved.messages.some((message) => message.content === "written while connector was running"));
    assert.equal(saved.connectorActions.find((item) => item.id === proposal.id).status, "completed");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN;
    else process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("two concurrent approvals claim one connector side effect exactly once", async () => {
  const session = await createSession("connector-double-approval-test");
  const previousToken = process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, status: 200, json: async () => ({ id: "message-id" }) };
  };
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const proposal = await requestConnectorAction(session.id, "gmail", "send_message", { to: "user@example.com", subject: "Hello", body: "Body" });
    const results = await Promise.allSettled([
      decideConnectorAction(session.id, proposal.id, true),
      decideConnectorAction(session.id, proposal.id, true),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN;
    else process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("untrusted attached projects disable connectors even after opt-in", async () => {
  const session = await createSession("connector-trust-test");
  try {
    session.project = { path: "placeholder", trusted: false };
    await saveSession(session);
    await setConnectorEnabled(session.id, "github", true);
    await assert.rejects(() => requestConnectorAction(session.id, "github", "create_issue", {}), /untrusted/);
  } finally { await cleanup(session.id); }
});

test("MCP transport lists only session-enabled connector tools", async () => {
  const session = await createSession("mcp-test");
  try {
    await setConnectorEnabled(session.id, "github", true);
    const initialized = await handleMcpRequest({ id: 1, method: "initialize", params: { protocolVersion: "test-version" } }, session.id);
    assert.equal(initialized.result.protocolVersion, "test-version");
    const listed = await handleMcpRequest({ id: 2, method: "tools/list" }, session.id, "connectors");
    assert.ok(listed.result.tools.some((tool) => tool.name === "connector__github__create_issue"));
    assert.equal(listed.result.tools.some((tool) => tool.name.includes("gmail")), false);
  } finally { await cleanup(session.id); }
});

test("Claude receives a strict per-run MCP config even when no connector is enabled", () => {
  setMcpBridgeUrl("http://127.0.0.1:3210");
  const emptyLaunch = claudeMcpLaunch("");
  const empty = emptyLaunch.args;
  assert.ok(empty.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(empty[empty.indexOf("--mcp-config") + 1]), { mcpServers: {} });
  const scopedLaunch = claudeMcpLaunch("session_123", "connectors");
  const scoped = scopedLaunch.args;
  const config = JSON.parse(scoped[scoped.indexOf("--mcp-config") + 1]);
  assert.equal(config.mcpServers.agent_room.env.AGENT_ROOM_SESSION_ID, "session_123");
  assert.equal(config.mcpServers.agent_room.env.AGENT_ROOM_MCP_CAPABILITY, "connectors");
  const token = config.mcpServers.agent_room.env.AGENT_ROOM_MCP_BRIDGE_TOKEN;
  assert.deepEqual(resolveMcpBridgeGrant(token), { sessionId: "session_123", capability: "connectors" });
  scopedLaunch.release();
  assert.equal(resolveMcpBridgeGrant(token), null);
});

test("MCP capability scopes cannot mix project reads with connector tools", async () => {
  const session = await createSession("mcp-scope-test");
  try {
    await setConnectorEnabled(session.id, "github", true);
    const connectorList = await handleMcpRequest({ id: 1, method: "tools/list" }, session.id, "connectors");
    assert.ok(connectorList.result.tools.every((tool) => tool.name.startsWith("connector__")));
    const projectList = await handleMcpRequest({ id: 2, method: "tools/list" }, session.id, "project");
    assert.ok(projectList.result.tools.every((tool) => tool.name.startsWith("project__")));
    const blocked = await handleMcpRequest({ id: 3, method: "tools/call", params: { name: "connector__github__create_issue", arguments: {} } }, session.id, "project");
    assert.match(blocked.error.message, /outside this MCP capability scope/);
  } finally { await cleanup(session.id); }
});
