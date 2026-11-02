// Collects named markdown definitions (agents, commands) from a list of config directories;
// the first directory that defines a name wins.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------- constants ----------
/** Project config directories searched for agents/ and commands/, in priority order. */
export const CONFIG_DIRS = [".exa", ".opencode", ".claude"];
const DEFINITION_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MARKDOWN_EXT = ".md";

// ---------- types ----------
export interface MarkdownFile {
  name: string;
  path: string;
  text: string;
}

// ---------- markdown files ----------
export async function readMarkdownDefinitions(dirs: string[]): Promise<MarkdownFile[]> {
  const seen = new Set<string>();
  const out: MarkdownFile[] = [];
  for (const d of dirs) {
    for (const e of await listSorted(d)) {
      if (!e.endsWith(MARKDOWN_EXT)) continue;
      const name = e.slice(0, -MARKDOWN_EXT.length);
      if (seen.has(name) || !DEFINITION_NAME.test(name)) continue;
      seen.add(name);
      const text = await readOrNull(join(d, e));
      if (text !== null) out.push({ name, path: join(d, e), text });
    }
  }
  return out;
}

// ---------- helpers ----------
async function listSorted(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return []; // directory doesn't exist
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null; // unreadable file: skip it (its name stays claimed)
  }
}
