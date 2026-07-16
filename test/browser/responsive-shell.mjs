import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function existingBrowser() {
  const candidates = [
    process.env.AGENT_ROOM_BROWSER,
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "",
    process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : "",
    process.platform === "win32" ? "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" : "",
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "",
    process.platform === "darwin" ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" : "",
    process.platform === "linux" ? "/usr/bin/google-chrome" : "",
    process.platform === "linux" ? "/usr/bin/chromium" : "",
    process.platform === "linux" ? "/usr/bin/chromium-browser" : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; }
    catch { /* Try the next supported system browser. */ }
  }
  throw new Error("No supported Chrome or Edge executable was found; set AGENT_ROOM_BROWSER");
}

async function waitFor(read, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (error?.fatal) throw error;
      /* The browser or page may still be starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the browser test condition");
}

class DevToolsSession {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Browser connection closed"));
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await Promise.race([
      this.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out opening the browser connection")), 5000)),
    ]);
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      response,
      new Promise((_, reject) => setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for browser command: ${method}`));
      }, 5000)),
    ]);
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
    }
    return result.result.value;
  }
}

async function setViewport(devtools, width, height) {
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(() => devtools.evaluate(`window.innerWidth === ${width} && window.innerHeight === ${height}`));
}

async function assertOverlay(devtools, triggerId, panelId) {
  await devtools.evaluate(`document.getElementById(${JSON.stringify(triggerId)}).click()`);
  const opened = await devtools.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(panelId)});
    return {
      open: panel.classList.contains("open"),
      visible: getComputedStyle(panel).display !== "none",
      focused: document.activeElement === panel,
      blocked: !document.getElementById("shellOverlayBackdrop").hidden,
      modal: panel.getAttribute("role") === "dialog" && panel.getAttribute("aria-modal") === "true",
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  assert.deepEqual(opened, { open: true, visible: true, focused: true, blocked: true, modal: true, overflow: false });
  await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  assert.equal(await devtools.evaluate(`document.getElementById(${JSON.stringify(panelId)}).classList.contains("open")`), false);
  assert.equal(await devtools.evaluate(`document.getElementById(${JSON.stringify(panelId)}).hasAttribute("aria-modal")`), false);
  assert.equal(await devtools.evaluate(`document.activeElement.id`), triggerId);
}

async function run() {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-browser-runtime-"));
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-browser-profile-"));
  let browser;
  let browserStderr = "";
  let devtools;
  let shutdownServer;
  try {
    console.log("browser check: starting server");
    process.env.AGENT_ROOM_RUNTIME_DIR = runtimeDir;
    process.env.NO_OPEN = "1";
    process.env.PORT = "0";
    const serverModule = await import("../../server/index.js");
    const { url } = await serverModule.serverReady;
    shutdownServer = serverModule.shutdownServer;

    const executable = await existingBrowser();
    console.log(`browser check: launching ${path.basename(executable)}`);
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--window-size=1280,800",
      url,
    ];
    if (typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");
    browser = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    browser.stderr.on("data", (chunk) => { browserStderr = `${browserStderr}${chunk}`.slice(-6000); });
    const portFile = path.join(profileDir, "DevToolsActivePort");
    const debugPort = await waitFor(async () => Number((await fs.readFile(portFile, "utf8")).split(/\r?\n/, 1)[0]));
    console.log("browser check: connected to browser");
    const pages = await waitFor(async () => {
      if (browser.exitCode !== null) {
        const error = new Error(`Browser exited before DevTools became ready: ${browserStderr}`);
        error.fatal = true;
        throw error;
      }
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) });
      const targets = await response.json();
      return targets.find((target) => target.type === "page" && target.url.startsWith(url) && target.webSocketDebuggerUrl);
    });
    console.log("browser check: page target found");
    devtools = new DevToolsSession(pages.webSocketDebuggerUrl);
    await devtools.send("Runtime.enable");
    await devtools.send("Page.enable");
    console.log("browser check: DevTools session ready");
    await waitFor(() => devtools.evaluate(`document.readyState === "complete"`));
    await waitFor(() => devtools.evaluate(`Boolean(document.getElementById("appShell"))`));
    await devtools.evaluate(`(() => {
      localStorage.setItem("agent-room-onboarded", "1");
      localStorage.setItem("agent-room-rail-collapsed", "1");
    })()`);
    await devtools.evaluate(`location.reload(); true`);
    await waitFor(() => devtools.evaluate(`document.readyState === "complete" && !document.getElementById("emptyState").hidden`));
    await setViewport(devtools, 800, 600);
    console.log("browser check: testing mobile cold start");
    await assertOverlay(devtools, "emptyRailDrawerToggle", "sessionsRail");
    await devtools.evaluate(`document.getElementById("emptyRailDrawerToggle").click()`);
    assert.deepEqual(await devtools.evaluate(`(() => ({
      newSessionVisible: getComputedStyle(document.getElementById("newSessionBtn")).display !== "none",
      sessionListVisible: getComputedStyle(document.getElementById("sessionList")).display !== "none",
      railWide: document.getElementById("sessionsRail").getBoundingClientRect().width > 250,
    }))()`), { newSessionVisible: true, sessionListVisible: true, railWide: true });
    await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await devtools.evaluate(`localStorage.removeItem("agent-room-rail-collapsed")`);
    await devtools.evaluate(`(async () => {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Responsive shell test" }),
      });
      return (await response.json()).id;
    })()`);
    await devtools.evaluate(`location.reload(); true`);
    await waitFor(() => devtools.evaluate(`Boolean(document.querySelector("#sessionList .session-item"))`), 20000);
    console.log("browser check: session created");
    await devtools.evaluate(`document.querySelector("#sessionList .session-item").click()`);
    await waitFor(() => devtools.evaluate(`!document.getElementById("sessionView").hidden`));

    await setViewport(devtools, 1280, 800);
    assert.equal(await devtools.evaluate(`document.getElementById("toggleContext").getAttribute("aria-expanded")`), "true");
    await setViewport(devtools, 980, 680);
    console.log("browser check: testing 980x680");
    await assertOverlay(devtools, "contextDrawerToggle", "contextCol");
    await devtools.evaluate(`(() => {
      const panel = document.getElementById("contextCol");
      document.getElementById("contextDrawerToggle").click();
      panel.insertAdjacentHTML("beforeend", "<details><summary>Context focus test</summary></details>");
      panel.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    })()`);
    assert.equal(await devtools.evaluate(`document.activeElement?.tagName`), "SUMMARY");
    await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await assertOverlay(devtools, "workflowToggle", "workflow");
    await devtools.evaluate(`document.documentElement.dataset.preset = "simple"`);
    await assertOverlay(devtools, "workflowToggle", "workflow");
    await devtools.evaluate(`document.documentElement.dataset.preset = "mission"`);
    await devtools.evaluate(`(() => {
      const button = document.getElementById("newSessionBtn");
      button.focus();
      button.click();
    })()`);
    await waitFor(() => devtools.evaluate(`document.activeElement.id === "newSessionName"`));
    await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(() => devtools.evaluate(`document.getElementById("newSessionModal").classList.contains("hidden")`));
    await waitFor(() => devtools.evaluate(`document.activeElement.id === "newSessionBtn"`));

    await setViewport(devtools, 800, 600);
    console.log("browser check: testing 800x600");
    await assertOverlay(devtools, "railDrawerToggle", "sessionsRail");
    await devtools.evaluate(`(() => {
      document.getElementById("railDrawerToggle").click();
      document.querySelector("#sessionList .session-item").click();
    })()`);
    await waitFor(() => devtools.evaluate(`!document.getElementById("sessionsRail").classList.contains("open")`));
    await waitFor(() => devtools.evaluate(`document.activeElement.id === "sessionTitle"`));
    assert.equal(await devtools.evaluate(`document.activeElement.id`), "sessionTitle");
    assert.equal(await devtools.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true);
    await devtools.evaluate(`document.querySelector('[data-lang="en"]').click()`);
    assert.equal(await devtools.evaluate(`document.documentElement.dir`), "ltr");
    assert.equal(await devtools.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true);
    await devtools.evaluate(`(() => {
      const tab = document.getElementById("tabDecision");
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    })()`);
    assert.equal(await devtools.evaluate(`document.activeElement.id`), "tabConversation");
    assert.equal(await devtools.evaluate(`document.getElementById("tabConversation").getAttribute("aria-selected")`), "true");

    await setViewport(devtools, 400, 300);
    assert.equal(await devtools.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true);
    await assertOverlay(devtools, "contextDrawerToggle", "contextCol");
  } catch (error) {
    if (devtools) {
      try {
        const shot = await devtools.send("Page.captureScreenshot", { format: "png" });
        const resultsDir = path.join(root, "test-results");
        await fs.mkdir(resultsDir, { recursive: true });
        await fs.writeFile(path.join(resultsDir, "responsive-shell-failure.png"), Buffer.from(shot.data, "base64"));
      } catch { /* Preserve the original assertion failure. */ }
    }
    if (browserStderr.trim()) error.message = `${error.message}\nBrowser stderr:\n${browserStderr.trim()}`;
    throw error;
  } finally {
    if (devtools) {
      try { await devtools.send("Browser.close"); }
      catch { if (browser?.exitCode === null) browser.kill("SIGKILL"); }
    } else if (browser?.exitCode === null) browser.kill("SIGKILL");
    if (browser?.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => browser.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    devtools?.socket.close();
    await shutdownServer?.("browser_test");
    await fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

try {
  await run();
  console.log("responsive browser checks passed");
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
}
