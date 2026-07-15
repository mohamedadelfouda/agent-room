import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = process.env.AGENT_ROOM_RUNTIME_DIR ? path.resolve(process.env.AGENT_ROOM_RUNTIME_DIR) : path.resolve(__dirname, "..");
const LOG_DIR = path.join(RUNTIME_ROOT, "logs");
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
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/sk-[A-Za-z0-9_\-]{10,}/g, "<redacted-key>")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<redacted-key>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted-key>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-key>")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<redacted-key>")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "<redacted-key>")
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

export const logError = (msg, extra) => log("ERROR", msg, extra);
