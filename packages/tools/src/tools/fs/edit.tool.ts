// edit: replace one (or every) occurrence of a text block in a file, or create a new file
// when oldString is empty.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool, type ToolContext } from "@exa/core";
import { z } from "zod";
import { fileTimesFor } from "../../helpers/file-times.helper.ts";
import { pathAsks, resolvePath } from "../../helpers/paths.helper.ts";
import { countLines } from "./file-content.ts";
import { suggestSimilarPaths } from "./path-suggest.ts";
import { locate, type TextRange } from "./text-locate.ts";

// ---------- constants ----------
const NOT_FOUND_MESSAGE =
  "oldString not found in the file. Read the file again and copy the exact text (including whitespace).";

// ---------- types ----------
interface EditInput {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

// ---------- edit tool ----------
export const editTool = defineTool({
  name: "edit",
  description:
    "Replace text in a file. oldString must match exactly one location (include enough surrounding lines to make it unique) " +
    "unless replaceAll is true. Read the file first. Preserve the file's indentation in newString.",
  schema: z.object({
    filePath: z.string().min(1),
    oldString: z
      .string()
      .describe("Exact text to replace (empty string creates a new file with newString)"),
    newString: z.string().describe("Replacement text (must differ from oldString)"),
    replaceAll: z.boolean().optional().describe("Replace every occurrence"),
  }),
  permissionKey: "edit",
  readonly: false,
  permissions: (input, ctx) => {
    const r = resolvePath(ctx, input.filePath);
    return pathAsks("edit", r, `edit ${r.rel}`);
  },
  async execute(input, ctx) {
    if (input.oldString === input.newString)
      throw new Error("oldString and newString are identical; nothing to change.");
    if (input.oldString === "") return createFile(input, ctx);
    return replaceInFile(input, ctx);
  },
});

// ---------- helpers ----------
async function createFile(input: EditInput, ctx: ToolContext) {
  const { abs, rel } = resolvePath(ctx, input.filePath);
  await assertMissing(abs);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, input.newString, "utf8");
  await recordWrite(ctx, abs);
  return {
    output: `Created ${abs}.`,
    title: rel,
    metadata: { additions: countLines(input.newString), deletions: 0, file: abs },
  };
}

async function replaceInFile(input: EditInput, ctx: ToolContext) {
  const { abs, rel } = resolvePath(ctx, input.filePath);
  await fileTimesFor(ctx)?.assertFresh(ctx.sessionId, abs);
  const content = await readOrSuggest(abs);
  const hits = matchTargets(content, input);
  await writeFile(abs, spliceRanges(content, hits, input.newString), "utf8");
  await recordWrite(ctx, abs);
  const replaced = hits.length;
  return {
    output: `Edited ${abs} (${replaced} replacement${replaced > 1 ? "s" : ""}).`,
    title: rel,
    metadata: {
      additions: countLines(input.newString) * replaced,
      deletions: countLines(input.oldString) * replaced,
      file: abs,
    },
  };
}

async function assertMissing(abs: string): Promise<void> {
  const exists = await stat(abs).then(
    () => true,
    () => false,
  );
  if (exists)
    throw new Error(`${abs} already exists; oldString must not be empty for existing files.`);
}

async function readOrSuggest(abs: string): Promise<string> {
  try {
    return await readFile(abs, "utf8");
  } catch {
    throw new Error(`File not found: ${abs}.${await suggestSimilarPaths(abs)}`);
  }
}

/** The ranges to replace: every hit with replaceAll, otherwise exactly one. */
function matchTargets(content: string, input: EditInput): TextRange[] {
  const hits = locate(content, input.oldString);
  if (!hits.length) throw new Error(NOT_FOUND_MESSAGE);
  if (input.replaceAll) return hits;
  if (hits.length > 1) {
    throw new Error(
      `oldString matches ${hits.length} locations. Add more surrounding context to make it unique, or set replaceAll.`,
    );
  }
  return [hits[0]];
}

function spliceRanges(content: string, ranges: TextRange[], replacement: string): string {
  let next = "";
  let cursor = 0;
  for (const r of ranges) {
    next += content.slice(cursor, r.start) + replacement;
    cursor = r.end;
  }
  return next + content.slice(cursor);
}

async function recordWrite(ctx: ToolContext, abs: string): Promise<void> {
  const st = await stat(abs);
  fileTimesFor(ctx)?.recordRead(ctx.sessionId, abs, st.mtimeMs);
}
