import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudePermissionArgs, runClaude } from "../../server/adapters/claude.js";
import { codexSecurityOverrides, prepareIsolatedCodexHome, runCodex } from "../../server/adapters/codex.js";

// The allowlist must be enforced on the REAL execution path (runClaude/runCodex spawn the
// agent), not only on the diagnostic endpoints. A client-supplied command that isn't the
// adapter's own CLI must be rejected before any process is spawned.

test("runClaude rejects a non-allowlisted command before spawning", async () => {
  await assert.rejects(
    () => runClaude({ prompt: "hi", config: { command: "calc" }, cwd: process.cwd() }),
    /not allowed/,
  );
});

test("runCodex rejects a non-allowlisted command (even the other agent's CLI)", async () => {
  await assert.rejects(
    () => runCodex({ prompt: "hi", config: { command: "claude" }, cwd: process.cwd() }),
    /not allowed/,
  );
});

test("runClaude rejects the win32 space-tokenization shape when on Windows", async () => {
  await assert.rejects(
    () => runClaude({ prompt: "hi", config: { command: "calc /claude" }, cwd: process.cwd() }),
    /absolute|not allowed/,
  );
});

test("runCodex rejects the removed prompt-only edit permission before command discovery", async () => {
  await assert.rejects(
    () => runCodex({ prompt: "hi", config: { command: "missing-codex", permission: "edit" }, cwd: process.cwd() }),
    /Unsupported Codex permission: edit/,
  );
});

test("runClaude rejects unsupported effort values", async () => {
  await assert.rejects(
    () => runClaude({ prompt: "hi", config: { effort: "ultracode" }, cwd: process.cwd() }),
    /Unsupported Claude effort/,
  );
});

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("Claude permissions expose an exact built-in tool surface", () => {
  assert.equal(flagValue(claudePermissionArgs("chat"), "--tools"), "WebSearch,WebFetch");
  assert.equal(flagValue(claudePermissionArgs("project"), "--tools"), "");
  assert.equal(flagValue(claudePermissionArgs("connectors"), "--tools"), "");
  assert.equal(flagValue(claudePermissionArgs("read"), "--tools"), "");
  assert.equal(flagValue(claudePermissionArgs("unknown"), "--tools"), "");
});

function configOverrides(args) {
  const overrides = [];
  for (let index = 0; index < args.length; index += 2) {
    assert.equal(args[index], "-c");
    overrides.push(args[index + 1]);
  }
  return overrides;
}

test("Codex permissions disable inherited external tool surfaces", () => {
  for (const [permission, webMode] of [["read", "disabled"], ["planread", "disabled"], ["run", "disabled"], ["chat", "live"]]) {
    const overrides = configOverrides(codexSecurityOverrides(permission));
    assert.ok(overrides.includes(`web_search="${webMode}"`));
    assert.ok(overrides.includes("mcp_servers={}"));
    for (const feature of ["apps", "hooks", "multi_agent", "memories"]) {
      assert.ok(overrides.includes(`features.${feature}=false`));
    }
  }
});

test("Codex isolated home copies auth only and distrusts project config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-codex-home-test-"));
  try {
    const sourceHome = path.join(root, "source-home");
    const project = path.join(root, "project");
    const tempDir = path.join(root, "run");
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(path.join(project, ".git"), { recursive: true });
    await fs.writeFile(path.join(sourceHome, "auth.json"), '{"token":"test-only"}');
    await fs.writeFile(path.join(sourceHome, "config.toml"), '[mcp_servers.evil]\ncommand = "evil"\n');

    const isolatedHome = await prepareIsolatedCodexHome({
      tempDir,
      cwd: project,
      sourceEnv: { CODEX_HOME: sourceHome },
    });

    assert.equal(await fs.readFile(path.join(isolatedHome, "auth.json"), "utf8"), '{"token":"test-only"}');
    const config = await fs.readFile(path.join(isolatedHome, "config.toml"), "utf8");
    assert.match(config, /trust_level = "untrusted"/);
    assert.match(config, /mcp_servers = \{\}/);
    assert.match(config, /apps = false/);
    assert.doesNotMatch(config, /evil/);
    assert.deepEqual((await fs.readdir(isolatedHome)).sort(), ["auth.json", "config.toml"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
