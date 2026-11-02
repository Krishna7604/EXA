// Wire encoding helpers: SSE for event streams, NDJSON for model streams.

import type { ExaEvent } from "../models/events.model.ts";

// ---------- constants ----------
/** SSE frames end with a blank line; tolerate \r\n. */
const FRAME_END = /\r?\n\r?\n/;
const FRAME_END_AT_START = /^\r?\n\r?\n/;
const LINE_BREAK = /\r?\n/;

const enc = new TextEncoder();

// ---------- types ----------
export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

// ---------- sse ----------
export function sseEncode(e: ExaEvent): Uint8Array {
  return enc.encode(`id: ${e.seq}\nevent: ${e.type}@${e.v}\ndata: ${JSON.stringify(e)}\n\n`);
}

export function sseComment(text: string): Uint8Array {
  return enc.encode(`: ${text}\n\n`);
}

/** Incremental SSE parser — feed decoded text, get complete frames. */
export class SseParser {
  private buf = "";

  push(chunk: string): SseFrame[] {
    this.buf += chunk;
    const out: SseFrame[] = [];
    for (let raw = this.takeRawFrame(); raw !== null; raw = this.takeRawFrame()) {
      const frame = parseFrame(raw);
      if (frame) out.push(frame);
    }
    return out;
  }

  /** Remove and return the next complete frame's text, or null if none is buffered yet. */
  private takeRawFrame(): string | null {
    const idx = this.buf.search(FRAME_END);
    if (idx === -1) return null;
    const raw = this.buf.slice(0, idx);
    const sepLength = this.buf.slice(idx).match(FRAME_END_AT_START)![0].length;
    this.buf = this.buf.slice(idx + sepLength);
    return raw;
  }
}

/** Read a fetch body as SSE frames. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const parser = new SseParser();
  const dec = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      for (const f of parser.push(dec.decode(value, { stream: true }))) yield f;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------- ndjson ----------
export function ndjsonLine(obj: unknown): Uint8Array {
  return enc.encode(`${JSON.stringify(obj)}\n`);
}

export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const dec = new TextDecoder();
  const reader = body.getReader();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line) as T;
      }
    }
    if (buf.trim()) yield JSON.parse(buf) as T;
  } finally {
    reader.releaseLock();
  }
}

// ---------- helpers ----------
/** Parse one frame's lines; returns null for comment-only / empty frames. */
function parseFrame(raw: string): SseFrame | null {
  const frame: SseFrame = { data: "" };
  const data: string[] = [];
  for (const line of raw.split(LINE_BREAK)) {
    if (!line || line.startsWith(":")) continue;
    const { field, value } = splitField(line);
    if (field === "data") data.push(value);
    else if (field === "id") frame.id = value;
    else if (field === "event") frame.event = value;
  }
  if (!data.length && !frame.event) return null;
  frame.data = data.join("\n");
  return frame;
}

function splitField(line: string): { field: string; value: string } {
  const colon = line.indexOf(":");
  if (colon === -1) return { field: line, value: "" };
  return { field: line.slice(0, colon), value: line.slice(colon + 1).replace(/^ /, "") };
}
