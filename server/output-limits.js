import fs from "node:fs/promises";

export const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_AGENT_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_STREAM_LINE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

const TRUNCATED = "\n…[truncated]";

export class CappedText {
  constructor(maxBytes = MAX_AGENT_TEXT_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.bytes = 0;
    this.truncated = false;
  }

  append(value) {
    if (value === undefined || value === null || this.truncated) return this;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const room = this.maxBytes - this.bytes;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      return this;
    }
    if (room > 0) {
      this.chunks.push(chunk.subarray(0, room));
      this.bytes += room;
    }
    this.truncated = true;
    return this;
  }

  replace(value) {
    this.chunks = [];
    this.bytes = 0;
    this.truncated = false;
    return this.append(value);
  }

  toString() {
    const text = Buffer.concat(this.chunks, this.bytes).toString("utf8");
    return this.truncated ? `${text}${TRUNCATED}` : text;
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.bytes);
  }
}

export function agentTimeoutMs(value = process.env.AGENT_ROOM_AGENT_TIMEOUT_MS) {
  if (value === undefined || value === null || value === "") return DEFAULT_AGENT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 60 * 60 * 1000) {
    throw new Error("Agent timeout must be an integer between 1000 and 3600000 milliseconds");
  }
  return timeout;
}

export async function readTextFileCapped(filePath, maxBytes = MAX_AGENT_TEXT_BYTES) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > maxBytes;
    const text = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8");
    return { text: truncated ? `${text}${TRUNCATED}` : text, truncated, bytesRead };
  } finally {
    await handle.close();
  }
}
