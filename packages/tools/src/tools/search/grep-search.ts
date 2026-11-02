// Search backends for the grep tool: ripgrep when installed (fast, honours .gitignore),
// otherwise a bounded pure-JS directory walk.

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { IGNORED_DIRS } from "../../constants/ignored-dirs.constants.ts";

// ---------- constants ----------
/** Longest line text kept per match. */
const MAX_LINE_CHARS = 400;
/** JS fallback stops descending once it has this many hits (5× the grep display limit). */
const JS_MAX_HITS = 500;
const JS_MAX_FILES = 20_000;
const JS_MAX_FILE_BYTES = 2_000_000;
/** ripgrep exits 2 on real errors (bad regex, unreadable path). */
const RG_ERROR_EXIT = 2;
const RG_ERROR_PREVIEW_CHARS = 500;
const RG_LINE = /^(.*?):(\d+):(.*)$/;

/** Cached `which rg`: undefined = not looked up yet, null = not installed. */
let rgPath: string | null | undefined;

// ---------- types ----------
export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

export interface GrepQuery {
  pattern: string;
  dir: string;
  include: string | undefined;
  signal: AbortSignal;
}

// ---------- search ----------
/** Run the query with ripgrep if available, else with the JS fallback. */
export function searchFiles(q: GrepQuery): Promise<GrepHit[]> {
  return ripgrep() ? rgSearch(q) : jsSearch(q);
}

// ---------- helpers ----------
function ripgrep(): string | null {
  if (rgPath === undefined) rgPath = Bun.which("rg");
  return rgPath;
}

async function rgSearch(q: GrepQuery): Promise<GrepHit[]> {
  const args = [
    ripgrep()!,
    "-n",
    "--no-heading",
    "--color",
    "never",
    "--max-columns",
    String(MAX_LINE_CHARS),
    "--max-columns-preview",
    "-e",
    q.pattern,
  ];
  if (q.include) args.push("--glob", q.include);
  args.push(q.dir);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: q.signal });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === RG_ERROR_EXIT && err.trim())
    throw new Error(`grep failed: ${err.trim().slice(0, RG_ERROR_PREVIEW_CHARS)}`);
  return parseRgOutput(out);
}

function parseRgOutput(out: string): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const l of out.split("\n")) {
    if (!l) continue;
    const m = l.match(RG_LINE);
    if (m) hits.push({ file: m[1], line: Number(m[2]), text: m[3] });
  }
  return hits;
}

async function jsSearch(q: GrepQuery): Promise<GrepHit[]> {
  const walker = new JsGrepWalker(q);
  await walker.walk(q.dir);
  return walker.hits;
}

/** Recursive directory walk that greps each eligible file, within the JS_MAX_* bounds. */
class JsGrepWalker {
  readonly hits: GrepHit[] = [];
  private readonly re: RegExp;
  private readonly include: Bun.Glob | null;
  private files = 0;

  constructor(private readonly q: GrepQuery) {
    this.re = new RegExp(q.pattern);
    this.include = q.include ? new Bun.Glob(q.include) : null;
  }

  async walk(dir: string): Promise<void> {
    if (this.isExhausted()) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: search what we can
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await this.walk(p);
      else if (e.isFile()) await this.searchFile(p, e.name);
    }
  }

  private isExhausted(): boolean {
    return this.q.signal.aborted || this.hits.length >= JS_MAX_HITS || this.files > JS_MAX_FILES;
  }

  private async searchFile(p: string, name: string): Promise<void> {
    if (this.include && !this.include.match(relative(this.q.dir, p)) && !this.include.match(name))
      return;
    this.files++;
    const text = await readSmallTextFile(p);
    if (text === null) return;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (this.re.test(lines[i]))
        this.hits.push({ file: p, line: i + 1, text: lines[i].slice(0, MAX_LINE_CHARS) });
    }
  }
}

/** File content, or null when it's too big, unreadable or binary. */
async function readSmallTextFile(p: string): Promise<string | null> {
  let text: string;
  try {
    const st = await stat(p);
    if (st.size > JS_MAX_FILE_BYTES) return null;
    text = await readFile(p, "utf8");
  } catch {
    return null; // vanished or unreadable: skip it
  }
  return text.includes("\0") ? null : text;
}
