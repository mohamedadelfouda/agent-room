import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
} from "../../public/i18n-core.js";
import { STRINGS as catalog } from "../../public/strings.js";

const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

test("Arabic and English catalogs have identical keys and value types", () => {
  const arabicKeys = Object.keys(catalog.ar).sort();
  const englishKeys = Object.keys(catalog.en).sort();
  assert.deepEqual(arabicKeys, englishKeys);
  for (const key of arabicKeys) assert.equal(typeof catalog.ar[key], typeof catalog.en[key], key);
});

test("every static HTML translation hook exists in both catalogs", () => {
  const keys = [...html.matchAll(/data-i18n(?:-ph|-title|-aria-label)?=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(keys.length > 0);
  for (const key of new Set(keys)) {
    assert.ok(key in catalog.ar, `missing Arabic translation: ${key}`);
    assert.ok(key in catalog.en, `missing English translation: ${key}`);
  }
});

test("locale formatters use explicit Arabic and English locales", () => {
  assert.equal(localeId("ar"), "ar-EG");
  assert.equal(localeId("en"), "en-GB");
  assert.notEqual(formatLocaleNumber("ar", 1234), formatLocaleNumber("en", 1234));
  assert.notEqual(formatLocaleDuration("ar", 65000), formatLocaleDuration("en", 65000));
  assert.equal(formatLocaleDuration("en", Number.NaN), "");
  assert.equal(formatMessageCount("en", 1), "1 message");
  assert.equal(formatMessageCount("en", 2), "2 messages");
  assert.equal(formatMessageCount("ar", 1), "رسالة واحدة");
  assert.equal(formatMessageCount("ar", 2), "رسالتان");
  assert.match(formatMessageCount("ar", 3), /رسائل/);
});

test("known API, connector, and decision identifiers resolve to catalog keys", () => {
  assert.equal(errorMessageKey({ code: "session_busy" }), "errorSessionBusy");
  assert.equal(errorMessageKey({ route: { reasonCode: "project_trust_required" } }), "routeProjectTrustRequired");
  assert.equal(errorMessageKey({ code: "future_error" }), "errorUnexpected");
  assert.equal(connectorLabelKey("gmail"), "connectorGmail");
  assert.equal(connectorActionKeys("gmail", "send_message").label, "actionGmailSendMessage");
  assert.equal(connectorStatusKey("pending"), "actionPending");
  assert.equal(decisionTypeKey("connector_action"), "decisionTypeConnectorAction");
  assert.equal(decisionOutcomeKey("approved"), "decisionOutcomeApproved");
  assert.equal(decisionActionKey("merge"), "decisionActionMerge");

  const mappedKeys = [
    errorMessageKey({ code: "session_busy" }),
    errorMessageKey({ route: { reasonCode: "project_trust_required" } }),
    connectorLabelKey("gmail"),
    ...Object.values(connectorActionKeys("gmail", "send_message")),
    connectorStatusKey("pending"),
    decisionTypeKey("connector_action"),
    decisionOutcomeKey("approved"),
    decisionActionKey("merge"),
  ];
  for (const key of mappedKeys) {
    assert.ok(key in catalog.ar, `mapped key missing from Arabic catalog: ${key}`);
    assert.ok(key in catalog.en, `mapped key missing from English catalog: ${key}`);
  }
});
