// Read-before-write guard: an existing file may only be edited/overwritten if the agent read
// it in this session and it hasn't changed on disk since (someone else may have edited it).

import { stat } from "node:fs/promises";
import type { ToolContext } from "@exa/core";

// ---------- constants ----------
/** Filesystems round mtimes differently; allow this much drift before calling a file stale. */
const MTIME_TOLERANCE_MS = 1;

// ---------- file times ----------
export class FileTimes {
  /** sessionId → (absolute path → mtime at last read). */
  private readonly reads = new Map<string, Map<string, number>>();

  recordRead(sessionId: string, abs: string, mtimeMs: number): void {
    let m = this.reads.get(sessionId);
    if (!m) {
      m = new Map();
      this.reads.set(sessionId, m);
    }
    m.set(abs, mtimeMs);
  }

  /** Throws a model-readable error when the guard fails; no-op for new files. */
  async assertFresh(sessionId: string, abs: string): Promise<void> {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(abs);
    } catch {
      return; // new file: nothing to protect
    }
    const seen = this.reads.get(sessionId)?.get(abs);
    if (seen === undefined) {
      throw new Error(`You must read ${abs} before modifying it. Use the read tool first.`);
    }
    if (Math.abs(st.mtimeMs - seen) > MTIME_TOLERANCE_MS) {
      throw new Error(
        `${abs} was modified since you last read it. Read it again before modifying it.`,
      );
    }
  }

  forget(sessionId: string): void {
    this.reads.delete(sessionId);
  }
}

/** The session's FileTimes service, when the host provides one. */
export function fileTimesFor(ctx: ToolContext): FileTimes | undefined {
  return ctx.services.fileTimes as FileTimes | undefined;
}
