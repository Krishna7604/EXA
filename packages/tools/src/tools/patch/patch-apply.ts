// Applying parsed patch hunks to file content: each hunk's old lines are located (exact,
// then whitespace-trimmed) after the previous hunk and replaced by its new lines.

import type { PatchChunk } from "./patch-parse.ts";

// ---------- constants ----------
/** How many of a failed hunk's lines to echo back in the error. */
const FAILED_HUNK_PREVIEW_LINES = 6;

// ---------- apply ----------
export function applyChunks(
  content: string,
  chunks: Array<{ old: string[]; new: string[] }>,
  path: string,
): string {
  const trailingNl = content.endsWith("\n");
  let lines = content.split("\n");
  if (trailingNl) lines.pop();
  let cursor = 0;
  for (const c of chunks) {
    if (!c.old.length) {
      lines = [...lines, ...c.new];
      continue;
    }
    const at = findBlock(lines, c.old, cursor);
    if (at === -1) throw hunkMismatch(path, c);
    lines = [...lines.slice(0, at), ...c.new, ...lines.slice(at + c.old.length)];
    cursor = at + c.new.length;
  }
  return lines.join("\n") + (trailingNl || lines.length ? "\n" : "");
}

// ---------- helpers ----------
/** First index ≥ `from` where `block` matches exactly; failing that, modulo surrounding whitespace. */
function findBlock(lines: string[], block: string[], from: number): number {
  const exact = findBlockWith(lines, block, from, (a, b) => a === b);
  if (exact !== -1) return exact;
  return findBlockWith(lines, block, from, (a, b) => a.trim() === b.trim());
}

function findBlockWith(
  lines: string[],
  block: string[],
  from: number,
  eq: (a: string, b: string) => boolean,
): number {
  for (let s = from; s + block.length <= lines.length; s++) {
    if (block.every((b, k) => eq(lines[s + k], b))) return s;
  }
  return -1;
}

function hunkMismatch(path: string, chunk: PatchChunk): Error {
  const preview = chunk.old.slice(0, FAILED_HUNK_PREVIEW_LINES).join("\n");
  return new Error(
    `hunk did not match in ${path}:\n${preview}\nRead the file again and regenerate the patch.`,
  );
}
