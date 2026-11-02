// Skills discovery: SKILL.md folders under .exa/.agents/.claude/.opencode skill directories,
// project first, then the user's home, then any extra directories. First name wins.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillInfo, SkillsPort } from "@exa/core";
import { parseFrontmatter } from "./frontmatter.ts";

// ---------- constants ----------
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_DIR_NAMES = [".exa/skills", ".agents/skills", ".claude/skills", ".opencode/skills"];
const SKILL_FILE = "SKILL.md";
/** How long a skills listing is reused before rescanning the disk. */
const LIST_CACHE_MS = 5000;
const MAX_DESCRIPTION_CHARS = 1024;

// ---------- local skills ----------
/** Skills from .exa/.agents/.claude/.opencode skill folders (project first, then global). */
export class LocalSkills implements SkillsPort {
  private cached: { at: number; list: SkillInfo[] } | null = null;

  constructor(
    private readonly root: string,
    private readonly home: string = homedir(),
    private readonly extraDirs: string[] = [],
  ) {}

  async list(): Promise<SkillInfo[]> {
    if (this.cached && Date.now() - this.cached.at < LIST_CACHE_MS) return this.cached.list;
    const seen = new Map<string, SkillInfo>();
    for (const dir of this.dirs()) await collectSkills(dir, seen);
    const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.cached = { at: Date.now(), list };
    return list;
  }

  async load(name: string): Promise<{ info: SkillInfo; body: string } | null> {
    const info = (await this.list()).find((s) => s.name === name);
    if (!info) return null;
    const { body } = parseFrontmatter(await readFile(info.location, "utf8"));
    return { info, body };
  }

  private dirs(): string[] {
    return [
      ...SKILL_DIR_NAMES.map((n) => join(this.root, n)),
      ...SKILL_DIR_NAMES.map((n) => join(this.home, n)),
      ...this.extraDirs,
    ];
  }
}

// ---------- helpers ----------
/** Add every valid skill in `dir` to `seen`, skipping names already found. */
async function collectSkills(dir: string, seen: Map<string, SkillInfo>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // directory doesn't exist
  }
  for (const e of entries) {
    if (seen.has(e) || !SKILL_NAME.test(e)) continue;
    const info = await readSkillInfo(join(dir, e, SKILL_FILE), e);
    if (info) seen.set(e, info);
  }
}

/** A skill's info, or null unless its frontmatter names it `name` and has a description. */
async function readSkillInfo(file: string, name: string): Promise<SkillInfo | null> {
  try {
    const { data } = parseFrontmatter(await readFile(file, "utf8"));
    if (data.name !== name || !data.description) return null;
    return { name, description: data.description.slice(0, MAX_DESCRIPTION_CHARS), location: file };
  } catch {
    return null; // not a skill dir
  }
}
