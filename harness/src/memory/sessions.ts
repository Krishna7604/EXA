// SessionManager — one file per session in work/sessions/, everything local.
// A new session is created on every launch; --resume/--session pick up an old one.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "./session.js";
import type { SessionInfo } from "./types.js";

function newId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `s-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`;
}

export class SessionManager {
  constructor(private readonly dir: string = "work/sessions") {}

  get directory(): string {
    return this.dir;
  }

  fileFor(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  exportFileFor(id: string): string {
    return join(this.dir, `${id}.md`);
  }

  store(id: string): SessionStore {
    return new SessionStore(this.fileFor(id));
  }

  async create(): Promise<SessionInfo> {
    await mkdir(this.dir, { recursive: true });
    const id = newId();
    await writeFile(this.fileFor(id), "", "utf8");
    return { id, file: this.fileFor(id), turns: 0, mtimeMs: Date.now() };
  }

  async info(id: string): Promise<SessionInfo> {
    const file = this.fileFor(id);
    const [st, raw] = await Promise.all([stat(file), readFile(file, "utf8").catch(() => "")]);
    return { id, file, turns: raw.split("\n").filter(Boolean).length, mtimeMs: st.mtimeMs };
  }

  async list(): Promise<SessionInfo[]> {
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir);
    const out: SessionInfo[] = [];
    for (const e of entries) {
      if (!e.endsWith(".jsonl")) continue;
      try {
        out.push(await this.info(e.slice(0, -".jsonl".length)));
      } catch {
        // skip unreadable files
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async latest(): Promise<SessionInfo | null> {
    return (await this.list())[0] ?? null;
  }
}

export const defaultSessions = new SessionManager();
