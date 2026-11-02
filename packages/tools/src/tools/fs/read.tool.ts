// read: return a file's lines with cat -n style numbers, paged by offset/limit.

import { readFile, stat } from "node:fs/promises";
import { defineTool } from "@exa/core";
import { z } from "zod";
import { fileTimesFor } from "../../helpers/file-times.helper.ts";
import { pathAsks, resolvePath } from "../../helpers/paths.helper.ts";
import { isBinary } from "./file-content.ts";
import { suggestSimilarPaths } from "./path-suggest.ts";

// ---------- constants ----------
const DEFAULT_READ_LIMIT = 2000;
const MAX_READ_LIMIT = 10_000;
const MAX_LINE = 2000;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const BYTES_PER_MB = 1e6;

// ---------- read tool ----------
export const readTool = defineTool({
  name: "read",
  description:
    "Read a file from the filesystem. Returns lines prefixed with line numbers (cat -n style). " +
    "By default reads up to 2000 lines from the start; use offset (1-based line) and limit for large files. " +
    "Lines longer than 2000 characters are truncated. You can call this tool several times in one step.",
  schema: z.object({
    filePath: z
      .string()
      .min(1)
      .describe("Absolute path, or path relative to the working directory"),
    offset: z.number().int().min(1).optional().describe("1-based line number to start from"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_READ_LIMIT)
      .optional()
      .describe("Number of lines to read"),
  }),
  readonly: true,
  permissions: (input, ctx) => pathAsks("read", resolvePath(ctx, input.filePath)),
  async execute(input, ctx) {
    const { abs, rel } = resolvePath(ctx, input.filePath);
    const st = await statReadable(abs, input.offset);
    const buf = await readFile(abs);
    if (isBinary(buf))
      throw new Error(`${abs} looks like a binary file; it can't be read as text.`);
    const lines = splitLines(buf.toString("utf8"));
    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    fileTimesFor(ctx)?.recordRead(ctx.sessionId, abs, st.mtimeMs);
    return {
      output: numberLines(slice, offset) + pageFooter(lines.length, offset, slice.length),
      title: rel,
      metadata: { lines: lines.length, shown: slice.length },
    };
  },
});

// ---------- helpers ----------
/** stat `abs`, rejecting missing files, directories and huge files read without an offset. */
async function statReadable(abs: string, offset: number | undefined) {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(abs);
  } catch {
    throw new Error(`File not found: ${abs}.${await suggestSimilarPaths(abs)}`);
  }
  if (st.isDirectory())
    throw new Error(`${abs} is a directory. Use the list or glob tool instead.`);
  if (st.size > MAX_READ_BYTES && !offset) {
    const mb = (st.size / BYTES_PER_MB).toFixed(1);
    throw new Error(`${abs} is ${mb} MB. Use offset/limit or grep to read part of it.`);
  }
  return st;
}

/** Split into lines, dropping the empty entry a trailing newline produces. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function numberLines(slice: string[], offset: number): string {
  const width = String(offset + slice.length).length;
  return slice
    .map((l, i) => `${String(offset + i).padStart(width, " ")}\t${truncateLine(l)}`)
    .join("\n");
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… [line truncated]` : line;
}

function pageFooter(total: number, offset: number, shown: number): string {
  const hasMore = offset - 1 + shown < total;
  if (hasMore) {
    const last = offset + shown - 1;
    const next = offset + shown;
    return `\n\n(File has ${total} lines; showing ${offset}-${last}. Use offset=${next} to continue.)`;
  }
  return total === 0 ? "(empty file)" : "";
}
