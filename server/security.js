import crypto from "node:crypto";

// A fresh 256-bit token per server run. It's handed to the page as an HttpOnly,
// SameSite=Strict cookie (see issueCookieHeader) so the browser attaches it to
// every same-origin fetch AND EventSource request — EventSource can't send custom
// headers, so a cookie is the one mechanism that covers both. A cross-site page
// can't read the cookie (HttpOnly) and the browser won't send it cross-site
// (SameSite=Strict), which — together with the Host and Origin checks — closes the
// unauthenticated-localhost / DNS-rebinding / CSRF hole.
const TOKEN = crypto.randomBytes(32).toString("hex");
const COOKIE_NAME = "agentRoomToken";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function issueCookieHeader() {
  // No Secure flag: the server is plain http on 127.0.0.1. Session-lifetime cookie.
  return `${COOKIE_NAME}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`;
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function hostAllowed(host, port) {
  if (!host) return false;
  const [name, p] = host.startsWith("[") ? [host.slice(0, host.indexOf("]") + 1), host.split("]:")[1]] : host.split(":");
  if (!LOOPBACK.has(name)) return false;
  return p === undefined || p === String(port);
}

function originAllowed(origin, port) {
  if (!origin) return true; // same-origin GETs and non-browser clients send no Origin
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (!LOOPBACK.has(u.hostname)) return false;
  // Require an exact port match. Cookies are scoped to the host, not the port, so a
  // page on another local port (e.g. 127.0.0.1:80, whose Origin omits the port) is a
  // different origin that must not pass the CSRF check just because the port is blank.
  const originPort = u.port || (u.protocol === "https:" ? "443" : "80");
  return originPort === String(port);
}

// Auth check for /api/* routes: valid token (cookie or X-Agent-Room-Token header),
// plus a matching Origin for state-changing methods. Host is checked separately and
// globally (see hostAllowed) so even non-/api requests can't be reached via a
// rebound hostname.
export function checkApiAuth(req, port) {
  if (MUTATING.has(req.method) && !originAllowed(req.headers.origin, port)) {
    return { ok: false, status: 403, error: "Forbidden origin" };
  }
  const provided = parseCookies(req.headers.cookie)[COOKIE_NAME] || req.headers["x-agent-room-token"];
  if (!provided || provided.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN))) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

export function securityHeaders() {
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  };
}

// Test-only: lets the unit tests build a valid cookie/header without exposing the
// raw token as a named export in normal code paths.
export function __validTokenForTest() {
  return TOKEN;
}
