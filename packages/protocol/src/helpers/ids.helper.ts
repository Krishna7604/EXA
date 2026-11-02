// Time-ordered UUIDv7 ids: index-friendly in Postgres, sortable as strings.

// ---------- constants ----------
const UUID_BYTES = 16;
const TIMESTAMP_BYTES = 6;
/** rand_a holds a 12-bit per-millisecond counter. */
const COUNTER_MASK = 0xfff;
/** Fresh counters start in the lower half so a burst can't overflow within one ms. */
const COUNTER_START_RANGE = 0x800;
const VERSION_7 = 0x70;
const VARIANT_RFC4122 = 0x80;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Monotonic state shared by every call in this process.
let lastMs = 0;
let seq = 0;

// ---------- ids ----------
export function uuidv7(now: number = Date.now()): string {
  advanceCounter(now);
  const b = new Uint8Array(UUID_BYTES);
  crypto.getRandomValues(b);
  writeTimestamp(b, now);
  b[6] = VERSION_7 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = (b[8] & 0x3f) | VARIANT_RFC4122;
  return formatUuid(bytesToHex(b));
}

export const newId = uuidv7;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_PATTERN.test(s);
}

// ---------- helpers ----------
/** Monotonic within a millisecond: bump the counter; otherwise start a fresh random one. */
function advanceCounter(now: number): void {
  if (now === lastMs) {
    seq = (seq + 1) & COUNTER_MASK;
    return;
  }
  lastMs = now;
  seq = Math.floor(Math.random() * COUNTER_START_RANGE);
}

/** Big-endian 48-bit unix-ms timestamp in bytes 0..5. */
function writeTimestamp(b: Uint8Array, now: number): void {
  const ms = BigInt(now);
  for (let i = 0; i < TIMESTAMP_BYTES; i++) {
    b[i] = Number((ms >> BigInt(8 * (TIMESTAMP_BYTES - 1 - i))) & 0xffn);
  }
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function formatUuid(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
