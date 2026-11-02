// Project instructions for the system prompt: a global ~/.exa/AGENTS.md (or
// ~/.claude/CLAUDE.md), then AGENTS.md (CLAUDE.md fallback) in every directory from the
// root down to cwd, then any extra configured files.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { InstructionsPort } from "@exa/core";

// ---------- constants ----------
const GLOBAL_FILES = [
  { path: [".exa", "AGENTS.md"], source: "~/.exa/AGENTS.md" },
  { path: [".claude", "CLAUDE.md"], source: "~/.claude/CLAUDE.md" },
];
/** Per-directory instruction files, in order of preference. */
const DIRECTORY_FILES = ["AGENTS.md", "CLAUDE.md"];

// ---------- types ----------
interface Instruction {
  source: string;
  content: string;
}

// ---------- local instructions ----------
/** AGENTS.md (CLAUDE.md fallback) from cwd up to the root, plus a global file. Cached by mtime. */
export class LocalInstructions implements InstructionsPort {
  private readonly cache = new Map<string, { mtime: number; content: string }>();

  constructor(
    private readonly root: string,
    private readonly cwd: string,
    private readonly extra: string[] = [],
    private readonly home: string = homedir(),
  ) {}

  async load(): Promise<Array<{ source: string; content: string }>> {
    const out: Instruction[] = [];
    const global = await this.loadGlobal();
    if (global) out.push(global);
    for (const d of this.dirsFromRootToCwd()) {
      const found = await this.loadFromDir(d);
      if (found) out.push(found);
    }
    for (const f of this.extra) {
      const c = await this.readCached(resolve(this.root, f));
      if (c) out.push({ source: f, content: c });
    }
    return out;
  }

  /** The first global instructions file that exists and is non-empty. */
  private async loadGlobal(): Promise<Instruction | null> {
    for (const g of GLOBAL_FILES) {
      const c = await this.readCached(join(this.home, ...g.path));
      if (c) return { source: g.source, content: c };
    }
    return null;
  }

  /** Directories from the root (or the topmost ancestor inside it) down to cwd. */
  private dirsFromRootToCwd(): string[] {
    const dirs: string[] = [];
    let cur = resolve(this.cwd);
    const root = resolve(this.root);
    for (;;) {
      dirs.unshift(cur);
      if (cur === root) break;
      const parent = dirname(cur);
      if (parent === cur || !cur.startsWith(root)) break;
      cur = parent;
    }
    return dirs;
  }

  private async loadFromDir(dir: string): Promise<Instruction | null> {
    for (const name of DIRECTORY_FILES) {
      const c = await this.readCached(join(dir, name));
      if (c) return { source: join(dir, name), content: c };
    }
    return null;
  }

  private async readCached(file: string): Promise<string | null> {
    try {
      const st = await stat(file);
      const c = this.cache.get(file);
      if (c && c.mtime === st.mtimeMs) return c.content;
      const content = await readFile(file, "utf8");
      this.cache.set(file, { mtime: st.mtimeMs, content });
      return content;
    } catch {
      return null; // missing or unreadable: no instructions from this file
    }
  }
}
