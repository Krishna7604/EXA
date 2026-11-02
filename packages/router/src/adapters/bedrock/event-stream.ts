// Decoder for the AWS event-stream binary framing used by Bedrock ConverseStream.
// Frame: [total len u32][headers len u32][prelude crc u32][headers][payload][message crc u32].
// CRCs are not verified (TLS already protects the stream).

// ---------- constants ----------
/** Total length + headers length + prelude CRC. */
const PRELUDE_BYTES = 12;
/** Prelude plus the trailing message CRC. */
const MIN_FRAME_BYTES = 16;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MESSAGE_CRC_BYTES = 4;

const HEADER_BOOL_TRUE = 0;
const HEADER_BOOL_FALSE = 1;
const HEADER_BYTES = 6;
const HEADER_STRING = 7;
/** Header value types we skip over, by their fixed width in bytes. */
const FIXED_WIDTH_BYTES: Record<number, number> = {
  2: 1, // byte
  3: 2, // short
  4: 4, // int
  5: 8, // long
  8: 8, // timestamp
  9: 16, // uuid
};

const UTF8 = new TextDecoder();

// ---------- types ----------
export interface EsMessage {
  headers: Record<string, string>;
  payload: Uint8Array;
}

interface HeaderValue {
  /** Set only for header types we keep (booleans and strings). */
  value?: string;
  next: number;
}

// ---------- decoder ----------
export class EventStreamDecoder {
  private buf = new Uint8Array(0);

  /** Feed bytes; returns every frame that is now complete. */
  push(chunk: Uint8Array): EsMessage[] {
    this.append(chunk);
    const out: EsMessage[] = [];
    let frame = this.nextFrame();
    while (frame) {
      out.push(frame);
      frame = this.nextFrame();
    }
    return out;
  }

  private append(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
  }

  /** Cut one complete frame off the front of the buffer, or null if none is complete yet. */
  private nextFrame(): EsMessage | null {
    if (this.buf.length < PRELUDE_BYTES) return null;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const total = view.getUint32(0);
    const headersLen = view.getUint32(4);
    if (total < MIN_FRAME_BYTES || total > MAX_FRAME_BYTES)
      throw new Error("bedrock: corrupt event-stream frame");
    if (this.buf.length < total) return null;
    const end = PRELUDE_BYTES + headersLen;
    const headers = decodeHeaders(this.buf, view, end);
    const message = { headers, payload: this.buf.slice(end, total - MESSAGE_CRC_BYTES) };
    this.buf = this.buf.slice(total);
    return message;
  }
}

// ---------- helpers ----------
function decodeHeaders(buf: Uint8Array, view: DataView, end: number): Record<string, string> {
  const headers: Record<string, string> = {};
  let p = PRELUDE_BYTES;
  while (p < end) {
    const nameLen = buf[p];
    const name = UTF8.decode(buf.subarray(p + 1, p + 1 + nameLen));
    p += 1 + nameLen;
    const type = buf[p];
    const header = readHeaderValue(buf, view, { type, at: p + 1 });
    if (header.value !== undefined) headers[name] = header.value;
    p = header.next;
  }
  return headers;
}

function readHeaderValue(
  buf: Uint8Array,
  view: DataView,
  h: { type: number; at: number },
): HeaderValue {
  const { type, at } = h;
  if (type === HEADER_BOOL_TRUE || type === HEADER_BOOL_FALSE)
    return { value: String(type === HEADER_BOOL_TRUE), next: at };
  const fixedWidth = FIXED_WIDTH_BYTES[type];
  if (fixedWidth !== undefined) return { next: at + fixedWidth };
  if (type === HEADER_BYTES || type === HEADER_STRING) {
    const len = view.getUint16(at);
    const next = at + 2 + len;
    if (type === HEADER_BYTES) return { next };
    return { value: UTF8.decode(buf.subarray(at + 2, next)), next };
  }
  throw new Error(`bedrock: unknown event-stream header type ${type}`);
}
