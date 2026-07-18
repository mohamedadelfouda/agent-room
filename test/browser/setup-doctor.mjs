// SD-2 Setup Doctor: the persistent Doctor evolves the onboarding modal with inline per-provider setup,
// locked-mode framing, an attention badge, and a focus trap. Status is mocked so the render is identical
// on any machine (CI has no provider CLIs; a dev box may have them).
import assert from "node:assert/strict";
import { launchBrowserHarness, waitFor } from "./harness.mjs";

const STATUS = {
  claudeMissing: { providers: { claude: { installed: false, detail: "not found on PATH" }, codex: { installed: true, version: "codex-cli 1.0.0" } }, github: { authed: true, detail: "github.com" } },
  bothReady: { providers: { claude: { installed: true, version: "claude 1.0.0" }, codex: { installed: true, version: "codex-cli 1.0.0" } }, github: { authed: true, detail: "github.com" } },
};

// Intercept only /api/agents/status; everything else (providers catalog, update-check) hits the real server.
const mockStatus = (payload) => `(() => {
  const data = ${JSON.stringify(payload)};
  if (!window.__origFetch) window.__origFetch = window.fetch;
  window.fetch = (url, opts) => String(url).includes("/api/agents/status")
    ? Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }))
    : window.__origFetch(url, opts);
  return true;
})()`;

async function run() {
  const harness = await launchBrowserHarness();
  const { devtools } = harness;
  try {
    // Suppress the first-run auto-open so we drive the Doctor explicitly.
    await devtools.evaluate(`(() => { localStorage.setItem("agent-room-onboarded", "1"); return true; })()`);
    await devtools.evaluate(`location.reload(); true`);
    await waitFor(() => devtools.evaluate(`document.readyState === "complete" && Boolean(document.getElementById("openOnboard"))`));

    // --- Missing provider: inline install/discover panel + locked framing + focus moves into the modal ---
    await devtools.evaluate(mockStatus(STATUS.claudeMissing));
    await devtools.evaluate(`(() => { const b = document.getElementById("openOnboard"); b.focus(); b.click(); return true; })()`);
    await waitFor(() => devtools.evaluate(`Boolean(document.querySelector("#onboardList .onboard-detail"))`));
    // Focus moves into the dialog (openManagedModal focuses on the next frame — poll rather than snapshot).
    await waitFor(() => devtools.evaluate(`document.getElementById("onboardModal").contains(document.activeElement)`));

    const open = await devtools.evaluate(`(() => {
      const modal = document.getElementById("onboardModal");
      const claude = [...document.querySelectorAll("#onboardList .onboard-item")].find(i => i.querySelector(".ob-name")?.textContent === "Claude");
      const panel = claude?.querySelector(".onboard-detail");
      const hint = document.getElementById("onboardLockHint");
      return {
        modalVisible: !modal.classList.contains("hidden"),
        hasInstallCommand: Boolean(panel?.querySelector(".cli-setup-cmd")?.textContent?.trim()),
        hasDocsLink: /^https:\\/\\//.test(panel?.querySelector("a.ob-docs")?.getAttribute("href") || ""),
        hasActions: [...(panel?.querySelectorAll("button") || [])].filter(b => b.textContent.trim()).length >= 2,
        lockedHint: !hint.hidden && hint.classList.contains("is-locked") && hint.textContent.includes("🔒"),
        badge: document.getElementById("openOnboard").classList.contains("needs-setup"),
      };
    })()`);
    assert.deepEqual(open, {
      modalVisible: true, hasInstallCommand: true,
      hasDocsLink: true, hasActions: true, lockedHint: true, badge: true,
    });
    const missingBadgeLabel = await devtools.evaluate(`document.getElementById("openOnboard").getAttribute("aria-label")`);
    console.log("browser check: Doctor shows inline setup + locked framing + badge, focus trapped in the dialog");

    // --- Escape closes the Doctor and restores focus to the opener ---
    await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
    await waitFor(() => devtools.evaluate(`document.getElementById("onboardModal").classList.contains("hidden")`));
    await waitFor(() => devtools.evaluate(`document.activeElement?.id === "openOnboard"`));
    console.log("browser check: Escape closes the Doctor and returns focus to the opener");

    // --- Both ready: ready framing, no missing panels, no attention badge ---
    await devtools.evaluate(mockStatus(STATUS.bothReady));
    await devtools.evaluate(`(() => { document.getElementById("openOnboard").click(); return true; })()`);
    await waitFor(() => devtools.evaluate(`(() => { const h = document.getElementById("onboardLockHint"); return !h.hidden && !h.classList.contains("is-locked"); })()`));
    const ready = await devtools.evaluate(`(() => ({
      noMissingPanels: document.querySelectorAll("#onboardList .onboard-detail").length === 0,
      badge: document.getElementById("openOnboard").classList.contains("needs-setup"),
      lastChecked: Boolean(document.getElementById("onboardLastChecked").textContent.trim()),
    }))()`);
    assert.deepEqual(ready, { noMissingPanels: true, badge: false, lastChecked: true });
    // The ⚙ badge must expose a distinct accessible name (not just a CSS dot) when setup is incomplete.
    const readyBadgeLabel = await devtools.evaluate(`document.getElementById("openOnboard").getAttribute("aria-label")`);
    assert.ok(missingBadgeLabel && readyBadgeLabel && missingBadgeLabel !== readyBadgeLabel,
      `expected a distinct incomplete-setup aria-label; got missing="${missingBadgeLabel}" ready="${readyBadgeLabel}"`);
    console.log("browser check: the ⚙ badge exposes a distinct accessible name when setup is incomplete");
  } catch (error) {
    await harness.captureFailureScreenshot("setup-doctor-failure");
    throw harness.decorateError(error);
  } finally {
    await harness.cleanup();
  }
}

try {
  await run();
  console.log("setup doctor browser checks passed");
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
}
