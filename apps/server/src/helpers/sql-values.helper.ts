// Small value helpers shared by the batched-insert repositories (usage + audit).

// ---------- constants ----------
const UUID_RE = /^[0-9a-f-]{36}$/i;

// ---------- sql values ----------
/** Only UUID-shaped ids go into uuid columns; anything else is stored as null. */
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);

/** "($k+1,...,$k+n)" for one row of a multi-row insert, where k = offset. */
export function placeholders(offset: number, count: number): string {
  return `(${Array.from({ length: count }, (_, i) => `$${offset + i + 1}`).join(",")})`;
}
