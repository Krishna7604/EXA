// Class-level tests: SessionStore (temp file, never touches work/) + Compactor.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compactor } from "../compaction.js";
import { SessionStore } from "../session.js";

describe("SessionStore", () => {
  test("load on missing file returns []", async () => {
    const s = new SessionStore(join(tmpdir(), `exa-nope-${Date.now()}.jsonl`));
    expect(await s.loadSession()).toEqual([]);
  });

  test("append/load roundtrip preserves turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exa-sess-"));
    try {
      const s = new SessionStore(join(dir, "session.jsonl"));
      await s.appendTurn({ role: "user", text: "hi", correlationId: "c1" });
      await s.appendTurn({ role: "agent", text: "hello", correlationId: "c1" });
      const turns = await s.loadSession();
      expect(turns.length).toBe(2);
      expect(turns[0]).toMatchObject({ role: "user", text: "hi" });
      expect(turns[1]).toMatchObject({ role: "agent", text: "hello" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Compactor", () => {
  test("triggers at/above threshold only", () => {
    const c = new Compactor(0.8);
    expect(c.shouldCompact(79, 100)).toBe(false);
    expect(c.shouldCompact(80, 100)).toBe(true);
    expect(c.shouldCompact(99, 100)).toBe(true);
  });

  test("compact stub reports turn count", async () => {
    expect(await new Compactor().compact([1, 2, 3])).toContain("3 turns");
  });
});
