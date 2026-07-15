import { resolveAllowedCommand, runProcess } from "../process.js";
import { redact } from "../logger.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requiredText(value, label, max = 500) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\r\n]/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function githubRepo(value) {
  const repo = requiredText(value, "Repository", 200);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Repository must be owner/name");
  return repo;
}

async function gh(args, input = "") {
  const command = await resolveAllowedCommand("gh", new Set(["gh"]));
  const result = await runProcess({ command, args, input, envPolicy: "github", timeoutMs: 30000 });
  if (result.code !== 0) throw new Error(redact(result.stderr || "GitHub CLI action failed"));
  return result.stdout.trim();
}

function gmailToken() {
  const token = process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN;
  if (!token) throw new Error("Gmail connector is not configured");
  return token;
}

async function boundedJson(response, maxBytes = 1024 * 1024) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) throw new Error("Connector response exceeded the 1 MiB limit");
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Connector response exceeded the 1 MiB limit");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (!bytes) return {};
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

async function gmail(pathname, options = {}) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${gmailToken()}`, "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const data = await boundedJson(response);
  if (!response.ok) throw new Error(`Gmail request failed (${response.status}): ${redact(data.error?.message || "unknown error")}`);
  return data;
}

function supabaseConfig() {
  const rawUrl = process.env.AGENT_ROOM_SUPABASE_URL;
  const key = process.env.AGENT_ROOM_SUPABASE_KEY;
  if (!rawUrl || !key) throw new Error("Supabase connector is not configured");
  const url = new URL(rawUrl);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("Supabase URL must use HTTPS (except loopback development)");
  return { url: url.toString().replace(/\/$/, ""), key };
}

async function supabase(table, options = {}, params = new URLSearchParams()) {
  if (!IDENTIFIER.test(table)) throw new Error("Invalid Supabase table name");
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}?${params}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation", ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const data = await boundedJson(response);
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${redact(JSON.stringify(data).slice(0, 1000))}`);
  return data;
}

const connectors = new Map([
  ["github", {
    id: "github", label: "GitHub", configured: () => true,
    actions: {
      list_repositories: { description: "List repositories visible to the signed-in GitHub CLI", stateChanging: false, run: async (input) => JSON.parse(await gh(["repo", "list", "--limit", String(Math.min(100, Math.max(1, Number(input.limit) || 30))), "--json", "nameWithOwner,url,visibility,updatedAt"]) || "[]") },
      create_issue: { description: "Create a GitHub issue", stateChanging: true, run: async (input) => {
        const body = String(input.body || "").slice(0, 50000);
        return { url: await gh(["issue", "create", "--repo", githubRepo(input.repo), "--title", requiredText(input.title, "Title", 250), "--body-file", "-"], body) };
      } },
    },
  }],
  ["gmail", {
    id: "gmail", label: "Gmail", configured: () => Boolean(process.env.AGENT_ROOM_GMAIL_ACCESS_TOKEN),
    actions: {
      list_messages: { description: "List Gmail message identifiers", stateChanging: false, run: async (input) => gmail(`messages?${new URLSearchParams({ maxResults: String(Math.min(50, Math.max(1, Number(input.limit) || 20))), ...(input.query ? { q: String(input.query).slice(0, 500) } : {}) })}`) },
      get_message: { description: "Read one Gmail message with headers and body", stateChanging: false, run: async (input) => {
        const id = requiredText(input.id, "Message id", 200);
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Message id is invalid");
        return gmail(`messages/${id}?format=full`);
      } },
      send_message: { description: "Send an email through Gmail", stateChanging: true, run: async (input) => {
        const to = requiredText(input.to, "Recipient", 320);
        const subject = requiredText(input.subject, "Subject", 998);
        const body = String(input.body || "").slice(0, 100000);
        const raw = Buffer.from(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`).toString("base64url");
        return gmail("messages/send", { method: "POST", body: JSON.stringify({ raw }) });
      } },
    },
  }],
  ["supabase", {
    id: "supabase", label: "Supabase", configured: () => Boolean(process.env.AGENT_ROOM_SUPABASE_URL && process.env.AGENT_ROOM_SUPABASE_KEY),
    actions: {
      select_rows: { description: "Read rows from an explicitly named Supabase table", stateChanging: false, run: async (input) => {
        const params = new URLSearchParams({ select: String(input.select || "*").slice(0, 1000), limit: String(Math.min(100, Math.max(1, Number(input.limit) || 20))) });
        for (const [column, value] of Object.entries(input.equals || {})) {
          if (!IDENTIFIER.test(column)) throw new Error("Invalid Supabase filter column");
          params.set(column, `eq.${String(value).slice(0, 1000)}`);
        }
        return supabase(String(input.table || ""), {}, params);
      } },
      insert_row: { description: "Insert one row into an explicitly named Supabase table", stateChanging: true, run: async (input) => {
        if (!input.row || typeof input.row !== "object" || Array.isArray(input.row)) throw new Error("Supabase row must be an object");
        const body = JSON.stringify(input.row);
        if (Buffer.byteLength(body) > 100000) throw new Error("Supabase row is too large");
        return supabase(String(input.table || ""), { method: "POST", body });
      } },
    },
  }],
]);

export function connector(id) { return connectors.get(String(id || "").toLowerCase()) || null; }
export function connectorCatalog() {
  return [...connectors.values()].map((item) => ({
    id: item.id,
    label: item.label,
    configured: item.configured(),
    actions: Object.entries(item.actions).map(([id, action]) => ({ id, description: action.description, stateChanging: action.stateChanging })),
  }));
}
export async function executeConnectorAction(connectorId, actionId, input = {}) {
  const definition = connector(connectorId);
  if (!definition || !Object.hasOwn(definition.actions, actionId)) throw new Error("Unknown connector action");
  const action = definition.actions[actionId];
  if (!definition.configured()) throw new Error(`${definition.label} connector is not configured`);
  return action.run(input || {});
}
