// Memory slice — types. No runtime code; import with `import type`.

/** One persisted turn in session.jsonl (role/text plus metadata). */
export type SessionTurn = Record<string, unknown>;

/** One session file in work/sessions/. Everything stays local. */
export interface SessionInfo {
  id: string;
  file: string;
  turns: number;
  mtimeMs: number;
}
