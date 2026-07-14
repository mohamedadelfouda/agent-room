import fs from "node:fs/promises";
import path from "node:path";

const scopes = new Map();
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_READ_CHARS = 128000;

function validSessionId(value) {
  return /^[a-zA-Z0-9_-]{8,100}$/.test(String(value || ""));
}

function relativeInput(value = "") {
  const input = String(value || "").replace(/\\/g, "/");
  if (input.includes("\0") || path.posix.isAbsolute(input) || input.split("/").includes("..")) {
    throw new Error("Project tool paths must stay inside the attached project");
  }
  return input.replace(/^\.\//, "");
}

async function scopedPath(scope, relative = "") {
  const candidate = path.resolve(scope.root, relativeInput(relative));
  const resolved = await fs.realpath(candidate);
  const prefix = scope.root.endsWith(path.sep) ? scope.root : `${scope.root}${path.sep}`;
  if (resolved !== scope.root && !resolved.startsWith(prefix)) throw new Error("Project path escapes the attached project");
  return resolved;
}

export async function registerProjectScope(sessionId, root) {
  if (!validSessionId(sessionId)) throw new Error("Invalid project-tool session id");
  const canonicalRoot = await fs.realpath(root);
  const token = Symbol(sessionId);
  scopes.set(sessionId, { root: canonicalRoot, token });
  return () => {
    if (scopes.get(sessionId)?.token === token) scopes.delete(sessionId);
  };
}

export function projectToolDefinitions(sessionId) {
  if (!scopes.has(sessionId)) return [];
  return [
    {
      name: "project__list_directory",
      description: "List one directory inside the explicitly trusted project. Read-only and bounded.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "project__read_file",
      description: "Read a bounded text slice from a file inside the explicitly trusted project.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: MAX_READ_CHARS } },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ];
}

export async function executeProjectTool(sessionId, name, input = {}) {
  const scope = scopes.get(sessionId);
  if (!scope) throw new Error("No trusted project scope is active for this session");
  if (name === "project__list_directory") {
    const directory = await scopedPath(scope, input.path || "");
    const entries = [];
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) throw new Error("Directory has too many entries; request a narrower path");
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".agent-workspaces") continue;
      entries.push({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" });
    }
    return entries;
  }
  if (name === "project__read_file") {
    const file = await scopedPath(scope, input.path);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("Project path is not a regular file");
    const offset = Math.max(0, Number.isInteger(input.offset) ? input.offset : 0);
    const limit = Math.min(MAX_READ_CHARS, Math.max(1, Number.isInteger(input.limit) ? input.limit : 64000));
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, offset);
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      return { path: relativeInput(input.path), offset, nextOffset: offset + bytesRead, eof: offset + bytesRead >= stat.size, content };
    } finally {
      await handle.close();
    }
  }
  throw new Error("Unknown project tool");
}
