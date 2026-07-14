import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("static form controls have programmatic accessible names", () => {
  const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/gi)].map((match) => match[0]);

  for (const control of controls) {
    if (/\btype=["']hidden["']/i.test(control)) continue;
    const id = control.match(/\bid=["']([^"']+)["']/i)?.[1];
    assert.ok(id, `form control is missing an id: ${control}`);

    const hasAriaName = /\baria-(?:label|labelledby)=["'][^"']+["']/i.test(control);
    const hasLabel = new RegExp(`<label\\b[^>]*\\bfor=["']${escapeRegExp(id)}["']`, "i").test(html);
    assert.ok(hasAriaName || hasLabel, `#${id} is missing an associated label`);
  }
});
