// SessionManager tests — one file per session, temp dir only.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../sessions.js";

async function tempManager(): Promise<{ m: SessionManager; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "exa-sessmgr-"));
  return { m: new SessionManager(dir), dir };
}

describe("SessionManager", () => {
  test("create makes an empty session file, info reflects turns", async () => {
    const { m, dir } = await tempManager();
    try {
      const created = await m.create();
      expect(created.turns).toBe(0);
      expect(created.file).toBe(m.fileFor(created.id));
      await m.store(created.id).appendTurn({ role: "user", text: "hi" });
      const info = await m.info(created.id);
      expect(info.turns).toBe(1);
      expect((await m.store(created.id).loadSession()).length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("list is newest-first, latest returns the freshest", async () => {
    const { m, dir } = await tempManager();
    try {
      expect(await m.latest()).toBeNull();
      const a = await m.create();
      await new Promise((r) => setTimeout(r, 15));
      const b = await m.create();
      const ids = (await m.list()).map((s) => s.id);
      expect(ids).toEqual([b.id, a.id]);
      expect((await m.latest())?.id).toBe(b.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("info on a missing id throws", async () => {
    const { m, dir } = await tempManager();
    try {
      await expect(m.info("nope")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
