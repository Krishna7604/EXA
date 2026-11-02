// Opaque secret tokens (API tokens, device codes): random generation and the hash we store.
import { createHash } from "node:crypto";

// ---------- constants ----------
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const DEFAULT_TOKEN_BYTES = 32;

// ---------- tokens ----------
/** SHA-256 of a token; only this is stored, never the token itself. */
export const hashToken = (t: string): Buffer => createHash("sha256").update(t).digest();

/** `<prefix>_<base62 chars>`, one char per random byte. */
export function randomToken(prefix: string, bytes = DEFAULT_TOKEN_BYTES): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const x of b) s += BASE62[x % BASE62.length];
  return `${prefix}_${s}`;
}
