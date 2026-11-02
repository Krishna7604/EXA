// list: show a directory as an indented tree, skipping dependency and build directories.

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@exa/core";
import { z } from "zod";
import { IGNORED_DIRS } from "../../constants/ignored-dirs.constants.ts";
import { pathAsks, resolvePath } from "../../helpers/paths.helper.ts";

// ---------- constants ----------
const MAX_ENTRIES = 300;
const MAX_DEPTH = 6;
const INDENT = "  ";

// ---------- list tool ----------
export const listTool = defineTool({
  name: "list",
  description:
    "List files and directories as a tree (ignores node_modules, .git, build output). Prefer glob/grep when you know what you're looking for.",
  schema: z.object({
    path: z.string().optional().describe("Directory to list (default: working directory)"),
    ignore: z.array(z.string()).optional().describe("Extra directory names to skip"),
  }),
  readonly: true,
  permissions: (input, ctx) => pathAsks("list", resolvePath(ctx, input.path ?? ".")),
  async execute(input, ctx) {
    const { abs, rel } = resolvePath(ctx, input.path ?? ".");
    const tree = new TreeWalker(new Set([...IGNORED_DIRS, ...(input.ignore ?? [])]));
    await tree.walk(abs, "", 0);
    if (tree.count >= MAX_ENTRIES)
      tree.lines.push(`… (truncated at ${MAX_ENTRIES} entries; list a subdirectory or use glob)`);
    return {
      output: `${abs}/\n${tree.lines.map((l) => `${INDENT}${l}`).join("\n")}`,
      title: rel,
      metadata: { count: tree.count },
    };
  },
});

// ---------- helpers ----------
/** Depth-first walk collecting one line per entry, directories first, up to MAX_ENTRIES. */
class TreeWalker {
  readonly lines: string[] = [];
  count = 0;

  constructor(private readonly ignore: Set<string>) {}

  async walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (this.count >= MAX_ENTRIES || depth > MAX_DEPTH) return;
    const entries = await readSortedEntries(dir);
    for (const e of entries) {
      if (this.count >= MAX_ENTRIES) return;
      if (e.isDirectory() && this.isSkipped(e.name)) continue;
      this.count++;
      this.lines.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory()) await this.walk(join(dir, e.name), prefix + INDENT, depth + 1);
    }
  }

  private isSkipped(name: string): boolean {
    return this.ignore.has(name) || name.startsWith(".");
  }
}

/** Directory entries, directories first then by name; [] when unreadable. */
async function readSortedEntries(dir: string): Promise<Dirent[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // unreadable directory: list what we can
  }
  return entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  );
}
