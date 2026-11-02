// glob: find files by pattern with Bun.Glob, newest first, skipping ignored directories.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@exa/core";
import { z } from "zod";
import { IGNORED_DIRS } from "../../constants/ignored-dirs.constants.ts";
import { pathAsks, resolvePath } from "../../helpers/paths.helper.ts";

// ---------- constants ----------
const GLOB_LIMIT = 100;
/** Stop scanning after this many matches so huge trees stay responsive. */
const MAX_SCANNED = 5000;

// ---------- types ----------
interface FoundFile {
  path: string;
  mtimeMs: number;
}

// ---------- glob tool ----------
export const globTool = defineTool({
  name: "glob",
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py"). Returns paths sorted by modification time, newest first. Skips node_modules/.git/build output.',
  schema: z.object({
    pattern: z.string().min(1).describe("Glob pattern"),
    path: z.string().optional().describe("Directory to search in (default: working directory)"),
  }),
  readonly: true,
  permissions: (input, ctx) => {
    const r = resolvePath(ctx, input.path ?? ".");
    return [
      ...pathAsks("glob", r).filter((a) => a.permission === "external_directory"),
      { permission: "glob", patterns: [input.pattern] },
    ];
  },
  async execute(input, ctx) {
    const { abs } = resolvePath(ctx, input.path ?? ".");
    const found = await scanGlob(input.pattern, abs, ctx.signal);
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const shown = found.slice(0, GLOB_LIMIT);
    const isTruncated = found.length > GLOB_LIMIT;
    const more = isTruncated
      ? `\n(${found.length - GLOB_LIMIT} more results not shown — narrow the pattern)`
      : "";
    return {
      output: shown.length ? shown.map((f) => f.path).join("\n") + more : "No files found.",
      title: input.pattern,
      metadata: { count: found.length, truncated: isTruncated },
    };
  },
});

// ---------- helpers ----------
async function scanGlob(pattern: string, dir: string, signal: AbortSignal): Promise<FoundFile[]> {
  const glob = new Bun.Glob(pattern);
  const found: FoundFile[] = [];
  const files = glob.scan({ cwd: dir, onlyFiles: true, dot: false, followSymlinks: false });
  for await (const f of files) {
    if (signal.aborted) break;
    if (f.split("/").some((seg) => IGNORED_DIRS.has(seg))) continue;
    const path = join(dir, f);
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      continue; // vanished between scan and stat
    }
    found.push({ path, mtimeMs });
    if (found.length >= MAX_SCANNED) break;
  }
  return found;
}
