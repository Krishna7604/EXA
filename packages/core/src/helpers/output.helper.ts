// Tool output truncation: cap what the model sees and offload the full text to disk.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_LINES } from "../constants/output.constants.ts";
import type { ToolContext } from "../models/tool.model.ts";

// ---------- constants ----------
const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9_-]/g;
/** Owner read/write only: tool output can contain anything the agent saw. */
const OUTPUT_FILE_MODE = 0o600;

// ---------- output truncation ----------
/** Truncate for the model; keep the full text on disk and point at it. */
export async function truncateOutput(
  text: string,
  ctx: Pick<ToolContext, "outputDir" | "callId">,
  limits = { chars: MAX_OUTPUT_CHARS, lines: MAX_OUTPUT_LINES },
): Promise<{ output: string; truncated: boolean; fullPath?: string }> {
  const lines = text.split("\n");
  if (text.length <= limits.chars && lines.length <= limits.lines)
    return { output: text, truncated: false };
  let kept = lines.slice(0, limits.lines).join("\n");
  if (kept.length > limits.chars) kept = kept.slice(0, limits.chars);
  const fullPath = await saveFullOutput(text, ctx);
  const total = `${text.length} chars / ${lines.length} lines total`;
  const note = fullPath
    ? `\n\n[output truncated: ${total}. Full output saved to ${fullPath} — use read with offset/limit or grep on it instead of re-running.]`
    : `\n\n[output truncated: ${total}]`;
  return { output: kept + note, truncated: true, fullPath };
}

// ---------- helpers ----------
/** Writes the untruncated output next to the session; undefined when that fails. */
async function saveFullOutput(
  text: string,
  ctx: Pick<ToolContext, "outputDir" | "callId">,
): Promise<string | undefined> {
  try {
    await mkdir(ctx.outputDir, { recursive: true });
    const fullPath = join(ctx.outputDir, `${ctx.callId.replace(UNSAFE_FILENAME_CHARS, "_")}.txt`);
    await writeFile(fullPath, text, { encoding: "utf8", mode: OUTPUT_FILE_MODE });
    return fullPath;
  } catch {
    // best effort: the truncated output still reaches the model, just without a file pointer
    return undefined;
  }
}
