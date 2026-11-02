// grep: regex search over file contents, grouped by file with the newest files first.

import { stat } from "node:fs/promises";
import { defineTool } from "@exa/core";
import { z } from "zod";
import { pathAsks, resolvePath } from "../../helpers/paths.helper.ts";
import { type GrepHit, searchFiles } from "./grep-search.ts";

// ---------- constants ----------
const GREP_LIMIT = 100;

// ---------- grep tool ----------
export const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents with a regular expression (ripgrep syntax). Returns file:line: text matches, grouped by file, newest files first. " +
    'Use include to filter files (e.g. "*.ts", "*.{ts,tsx}").',
  schema: z.object({
    pattern: z.string().min(1).describe("Regex to search for"),
    path: z.string().optional().describe("Directory to search (default: working directory)"),
    include: z.string().optional().describe("File glob filter"),
  }),
  readonly: true,
  permissions: (input, ctx) => {
    const r = resolvePath(ctx, input.path ?? ".");
    return [
      ...pathAsks("grep", r).filter((a) => a.permission === "external_directory"),
      { permission: "grep", patterns: [input.pattern] },
    ];
  },
  async execute(input, ctx) {
    const { abs } = resolvePath(ctx, input.path ?? ".");
    const hits = await searchFiles({
      pattern: input.pattern,
      dir: abs,
      include: input.include,
      signal: ctx.signal,
    });
    if (!hits.length)
      return { output: "No matches found.", title: input.pattern, metadata: { matches: 0 } };
    const byFile = groupByFile(hits);
    const files = await sortNewestFirst([...byFile.keys()]);
    return {
      output: formatHits(files, byFile, hits.length),
      title: input.pattern,
      metadata: { matches: hits.length, files: files.length },
    };
  },
});

// ---------- helpers ----------
/** Group hits per file, keeping line order within a file. */
function groupByFile(hits: GrepHit[]): Map<string, GrepHit[]> {
  const byFile = new Map<string, GrepHit[]>();
  for (const h of hits) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }
  return byFile;
}

async function sortNewestFirst(files: string[]): Promise<string[]> {
  const mtimes = new Map<string, number>();
  await Promise.all(
    files.map(async (f) => mtimes.set(f, (await stat(f).catch(() => ({ mtimeMs: 0 }))).mtimeMs)),
  );
  return files.sort((a, b) => (mtimes.get(b) ?? 0) - (mtimes.get(a) ?? 0));
}

/** Render up to GREP_LIMIT matches as "file:" headers with indented "line: text" rows. */
function formatHits(files: string[], byFile: Map<string, GrepHit[]>, total: number): string {
  const out: string[] = [];
  let shown = 0;
  for (const f of files) {
    if (shown >= GREP_LIMIT) break;
    out.push(`${f}:`);
    for (const h of byFile.get(f)!) {
      if (shown >= GREP_LIMIT) break;
      out.push(`  ${h.line}: ${h.text}`);
      shown++;
    }
  }
  if (total > shown)
    out.push(`(${total - shown} more matches not shown — narrow the pattern or path)`);
  return out.join("\n");
}
