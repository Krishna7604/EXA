import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type SessionInfo, zeroTokens } from "@exa/protocol";
import { JsonlStore } from "../index.ts";

const A = { tenantId: newId(), userId: newId() };

const mkSession = (
  t: { tenantId: string; userId: string },
  mode: SessionInfo["storageMode"],
  host: SessionInfo["loopHost"] = "server",
): SessionInfo => ({
  id: newId(),
  tenantId: t.tenantId,
  userId: t.userId,
  projectId: null,
  parentId: null,
  title: null,
  directory: null,
  agent: "build",
  model: "exa",
  loopHost: host,
  storageMode: mode,
  status: "active",
  revert: null,
  tokens: zeroTokens(),
  cost: 0,
  time: { created: Date.now(), updated: Date.now() },
});

describe("local JSONL store", () => {
  test("roundtrip across processes (fresh instance reloads), deletes respected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exa-local-"));
    const a = new JsonlStore(dir);
    const s = mkSession(A, "local", "client");
    await a.createSession(s);
    const m1 = {
      id: newId(),
      sessionId: s.id,
      parentId: null,
      role: "user" as const,
      agent: "build",
      model: "exa",
      time: { created: 1 },
      tokens: zeroTokens(),
      cost: 0,
    };
    const m2 = { ...m1, id: newId() };
    await a.putMessage(m1);
    await a.putParts([
      { type: "text", id: newId(), messageId: m1.id, sessionId: s.id, text: "hi" },
    ]);
    await a.putMessage(m2);
    await a.deleteMessages(s.id, [m2.id]);
    await a.updateSession(s.id, { title: "T" });
    const b = new JsonlStore(dir);
    expect((await b.getSession(s.id))!.title).toBe("T");
    const msgs = await b.messages(s.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].parts[0]).toMatchObject({ type: "text", text: "hi" });
    expect((await b.list()).map((x) => x.id)).toEqual([s.id]);
    await b.compactFile(s.id);
    expect((await readFile(join(dir, `${s.id}.jsonl`), "utf8")).trim().split("\n").length).toBe(3);
  });
});
