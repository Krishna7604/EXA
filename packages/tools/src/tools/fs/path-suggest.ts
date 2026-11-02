// "Did you mean ...?" hints for file-not-found errors: siblings with a similar name.

import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// ---------- constants ----------
/** Names sharing this many leading characters count as similar. */
const SIMILAR_PREFIX_LENGTH = 4;
const MAX_SUGGESTIONS = 5;

// ---------- suggestions ----------
/** A sentence suggesting similar sibling paths, or "" when there are none. */
export async function suggestSimilarPaths(abs: string): Promise<string> {
  try {
    const dir = dirname(abs);
    const base = basename(abs).toLowerCase();
    const entries = await readdir(dir);
    const close = entries
      .filter((e) => isSimilarName(e.toLowerCase(), base))
      .slice(0, MAX_SUGGESTIONS);
    return close.length ? ` Did you mean: ${close.map((e) => join(dir, e)).join(", ")}?` : "";
  } catch {
    return ""; // unreadable parent dir: no hint is better than a confusing error
  }
}

// ---------- helpers ----------
function isSimilarName(entry: string, base: string): boolean {
  return (
    entry.includes(base.slice(0, SIMILAR_PREFIX_LENGTH)) ||
    base.includes(entry.slice(0, SIMILAR_PREFIX_LENGTH))
  );
}
