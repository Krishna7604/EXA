// Session persistence — work/session.jsonl, reloadable. Phase 4 adds compaction hook.
// Types live in ./types.ts.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import type { SessionTurn } from "./types.js";

const DEFAULT_FILE = "work/session.jsonl";

export class SessionStore {
  constructor(private file: string = DEFAULT_FILE) {}

  /** Repoint at another session file (session switching). */
  setFile(file: string): void {
    this.file = file;
  }

  getFile(): string {
    return this.file;
  }

  async appendTurn(turn: SessionTurn): Promise<void> {
    await mkdir("work", { recursive: true });
    await appendFile(this.file, JSON.stringify(turn) + "\n");
  }

  async loadSession(): Promise<SessionTurn[]> {
    try {
      const raw = await readFile(this.file, "utf8");
      return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionTurn);
    } catch {
      return [];
    }
  }
}

export const defaultSession = new SessionStore();

export async function appendTurn(turn: SessionTurn): Promise<void> {
  return defaultSession.appendTurn(turn);
}

export async function loadSession(): Promise<SessionTurn[]> {
  return defaultSession.loadSession();
}
