import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "logs");
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const LOG_FILE = path.join(LOG_DIR, "server.log");

const CURRENT_USER = process.env.USERNAME || process.env.USER || "";

// Strip secrets and personal paths from anything before it reaches a log file,
// a stored technical-details field, or the export. Never a full guarantee, but
// removes the obvious leaks (tokens, keys, auth headers, home paths).
export function redact(input) {
  let text = String(input ?? "");
  if (CURRENT_USER) text = text.split(CURRENT_USER).join("<user>");
  return text
    .replace(/sk-[A-Za-z0-9_\-]{10,}/g, "<redacted-key>")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1<redacted>")
    .replace(/([A-Za-z0-9_]*(?:TOKEN|APIKEY|API_KEY|KEY|SECRET|PASSWORD|AUTH)[A-Za-z0-9_]*\s*[=:]\s*)("?)[^"\s]+\2/gi, "$1<redacted>")
    .replace(/([A-Za-z]:\\Users\\)[^\\\/\s"]+/g, "$1<user>")
    .replace(/(\/(?:Users|home)\/)[^\/\s"]+/g, "$1<user>");
}

function formatLine(level, msg, extra) {
  const ts = new Date().toISOString();
  let out = `[${ts}] ${level} ${msg}`;
  if (extra !== undefined && extra !== null) {
    try { out += " " + (typeof extra === "string" ? extra : JSON.stringify(extra)); } catch { out += " [unserializable]"; }
  }
  return out + "\n";
}

export function log(level, msg, extra) {
  const text = redact(formatLine(level, msg, extra));
  try { fs.appendFileSync(LOG_FILE, text); } catch {}
  const stream = level === "ERROR" ? process.stderr : process.stdout;
  try { stream.write(text); } catch {}
}

export const logInfo = (msg, extra) => log("INFO", msg, extra);
export const logWarn = (msg, extra) => log("WARN", msg, extra);
export const logError = (msg, extra) => log("ERROR", msg, extra);
export function logPath() { return LOG_FILE; }
