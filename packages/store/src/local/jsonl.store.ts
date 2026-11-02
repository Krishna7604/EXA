// storage_mode = "local": the heavy client keeps conversation content on the user's machine
// as append-only JSONL (~/.exa/sessions/<id>.jsonl, mode 0600). Loaded once per process and
// served from memory afterwards; writes are appends (fast, crash-tolerant: a torn last line is
// skipped on load).
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStore, type SessionStore } from "@exa/core";
import type { MessageInfo, MessageWithParts, Part, SessionInfo } from "@exa/protocol";

// ---------- constants ----------
const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;
const FILE_EXT = ".jsonl";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DEFAULT_LIST_LIMIT = 50;

// ---------- types ----------
/** One JSONL line: session (s), session patch (sp), message (m), parts (p), deleted messages (dm). */
type Rec =
  | { k: "s"; v: SessionInfo }
  | { k: "sp"; v: Partial<SessionInfo> }
  | { k: "m"; v: MessageInfo }
  | { k: "p"; v: Part[] }
  | { k: "dm"; v: string[] };

// ---------- jsonl store ----------
export class JsonlStore implements SessionStore {
  private readonly mem = new MemoryStore();
  private readonly loaded = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {}

  async createSession(info: SessionInfo): Promise<void> {
    this.loaded.add(info.id);
    await this.mem.createSession(info);
    await this.append(info.id, { k: "s", v: info });
  }

  async getSession(id: string): Promise<SessionInfo | null> {
    await this.ensure(id);
    return this.mem.getSession(id);
  }

  async updateSession(id: string, patch: Partial<SessionInfo>): Promise<void> {
    await this.ensure(id);
    await this.mem.updateSession(id, patch);
    await this.append(id, { k: "sp", v: patch });
  }

  async messages(sessionId: string): Promise<MessageWithParts[]> {
    await this.ensure(sessionId);
    return this.mem.messages(sessionId);
  }

  async putMessage(info: MessageInfo): Promise<void> {
    await this.ensure(info.sessionId);
    await this.mem.putMessage(info);
    await this.append(info.sessionId, { k: "m", v: info });
  }

  async putParts(parts: Part[]): Promise<void> {
    if (!parts.length) return;
    await this.mem.putParts(parts);
    await this.append(parts[0].sessionId, { k: "p", v: parts });
  }

  async deleteMessages(sessionId: string, ids: string[]): Promise<void> {
    await this.mem.deleteMessages(sessionId, ids);
    await this.append(sessionId, { k: "dm", v: ids });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.chain;
    await this.mem.deleteSession(sessionId);
    this.loaded.delete(sessionId);
    await rm(this.file(sessionId), { force: true });
  }

  /** Rewrite a session file with only its current state (drops superseded records). */
  async compactFile(sessionId: string): Promise<void> {
    await this.ensure(sessionId);
    await this.chain;
    const s = await this.mem.getSession(sessionId);
    if (!s) return;
    const lines: string[] = [JSON.stringify({ k: "s", v: s })];
    for (const m of await this.mem.messages(sessionId)) {
      lines.push(JSON.stringify({ k: "m", v: m.info }));
      if (m.parts.length) lines.push(JSON.stringify({ k: "p", v: m.parts }));
    }
    const tmp = `${this.file(sessionId)}.tmp`;
    await writeFile(tmp, `${lines.join("\n")}\n`, { mode: FILE_MODE });
    await rename(tmp, this.file(sessionId));
  }

  /** Session summaries, newest first (reads only the session records). */
  async list(limit = DEFAULT_LIST_LIMIT): Promise<SessionInfo[]> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(FILE_EXT));
    } catch {
      return []; // no sessions directory yet
    }
    const out: SessionInfo[] = [];
    for (const f of files) {
      const s = await this.getSession(f.slice(0, -FILE_EXT.length));
      if (s && !s.parentId) out.push(s);
    }
    return out.sort((a, b) => b.time.updated - a.time.updated).slice(0, limit);
  }

  private file(id: string): string {
    if (!SESSION_ID_RE.test(id)) throw new Error(`invalid session id ${id}`);
    return join(this.dir, `${id}${FILE_EXT}`);
  }

  private append(id: string, rec: Rec): Promise<void> {
    // serialize appends so records stay in order
    this.chain = this.chain.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
      await appendFile(this.file(id), `${JSON.stringify(rec)}\n`, { mode: FILE_MODE });
    });
    return this.chain;
  }

  /** Load a session file into memory once per process. */
  private async ensure(id: string): Promise<void> {
    if (this.loaded.has(id)) return;
    this.loaded.add(id);
    let raw: string;
    try {
      raw = await readFile(this.file(id), "utf8");
    } catch {
      return; // no file yet: a new session
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let rec: Rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // torn write
      }
      await this.replay(id, rec);
    }
  }

  private async replay(id: string, rec: Rec): Promise<void> {
    switch (rec.k) {
      case "s":
        return this.mem.createSession(rec.v);
      case "sp":
        return this.mem.updateSession(id, rec.v);
      case "m":
        return this.mem.putMessage(rec.v);
      case "p":
        return this.mem.putParts(rec.v);
      case "dm":
        return this.mem.deleteMessages(id, rec.v);
    }
  }
}
