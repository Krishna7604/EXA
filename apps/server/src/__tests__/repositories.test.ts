import { beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  AgentLoop,
  AgentRegistry,
  builtinRules,
  defineTool,
  EventBus,
  ScriptedModel,
  ToolRegistry,
  text,
  toolCall,
} from "@exa/core";
import { type MessageInfo, newId, type SessionInfo, zeroTokens } from "@exa/protocol";
import { migrate, PgliteDb, PostgresDb, TENANT_TABLES } from "@exa/store";
import { z } from "zod";
import { ConfigRepo } from "../repositories/config.repository.ts";
import { IdentityRepo } from "../repositories/identity.repository.ts";
import { ServerSessionStore } from "../repositories/server-session.store.ts";
import { SessionRepo } from "../repositories/session.repository.ts";
import { TelemetryWriter } from "../repositories/telemetry.repository.ts";

let db: PgliteDb | PostgresDb;
let ids: IdentityRepo;
let cfg: ConfigRepo;
let sessions: SessionRepo;
let A: { tenantId: string; userId: string };
let B: { tenantId: string; userId: string };

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

beforeAll(async () => {
  const url = process.env.EXA_TEST_DATABASE_URL;
  if (url) {
    db = await PostgresDb.open(url);
    await db.exec(
      "drop schema public cascade; create schema public; grant usage on schema public to public;",
    );
  } else db = await PgliteDb.open();
  await migrate(db);
  ids = new IdentityRepo(db);
  cfg = new ConfigRepo(db);
  sessions = new SessionRepo(db);
  const ta = await ids.createTenant("acme");
  const tb = await ids.createTenant("globex");
  const ua = await ids.upsertUser("a@acme.dev");
  const ub = await ids.upsertUser("b@globex.dev");
  await ids.addMember(ta.id, ua.id, "owner");
  await ids.addMember(tb.id, ub.id, "owner");
  A = { tenantId: ta.id, userId: ua.id };
  B = { tenantId: tb.id, userId: ub.id };
});

describe("tenant isolation (RLS)", () => {
  test("every tenant table is invisible across tenants", async () => {
    const s = mkSession(A, "server");
    await sessions.create(s);
    await sessions.putMessage(A.tenantId, {
      id: newId(),
      sessionId: s.id,
      parentId: null,
      role: "user",
      agent: "build",
      model: "exa",
      time: { created: 1 },
      tokens: zeroTokens(),
      cost: 0,
    });
    await cfg.putSetting(A, "tenant", A.tenantId, "models.default", "exa/fast");
    await cfg.addRule(A, {
      scope: "tenant",
      scopeId: A.tenantId,
      permission: "bash",
      pattern: "*",
      action: "deny",
    });
    for (const t of TENANT_TABLES) {
      const fromB = await db.withTenant(B.tenantId, (q) =>
        q.query<{ n: number }>(`select count(*)::int as n from ${t}`),
      );
      expect({ t, n: fromB[0].n }).toEqual({ t, n: 0 });
    }
    expect(await sessions.get(B.tenantId, s.id)).toBeNull();
    expect(await sessions.get(A.tenantId, s.id)).not.toBeNull();
  });

  test("writes with another tenant's id are rejected by the policy", async () => {
    await expect(
      db.withTenant(B.tenantId, (q) =>
        q.query(
          `insert into settings (tenant_id, scope, scope_id, key, value) values ($1,'tenant',$1,'x','1'::jsonb)`,
          [A.tenantId],
        ),
      ),
    ).rejects.toThrow();
    // updates/deletes across tenants silently affect nothing
    const r = await db.withTenant(B.tenantId, (q) => q.query(`delete from sessions returning id`));
    expect(r.length).toBe(0);
  });

  test("no tenant context → nothing visible", async () => {
    const r = await db.tx(async (q) => {
      await q.query("set local role exa_app");
      return q.query<{ n: number }>("select count(*)::int as n from sessions");
    });
    expect(r[0].n).toBe(0);
  });
});

describe("settings", () => {
  test("layering: user overrides tenant unless locked", async () => {
    await cfg.putSetting(A, "tenant", A.tenantId, "loop.maxSteps", 40);
    await cfg.putSetting(A, "user", A.userId, "loop.maxSteps", 10);
    expect((await cfg.resolveSettings(A)).values["loop.maxSteps"]).toBe(10);
    await cfg.putSetting(A, "tenant", A.tenantId, "storage.mode", "server", true);
    await expect(cfg.putSetting(A, "user", A.userId, "storage.mode", "none")).rejects.toThrow(
      "locked",
    );
    const r = await cfg.resolveSettings(A);
    expect(r.values["storage.mode"]).toBe("server");
    expect(r.locked.has("storage.mode")).toBe(true);
    expect(r.values["byok.enabled"]).toBe(true); // default
  });

  test("rules come back in precedence order, only tenant rules lock", async () => {
    await cfg.addRule(A, {
      scope: "user",
      scopeId: A.userId,
      permission: "bash",
      pattern: "git *",
      action: "allow",
      locked: true,
    });
    const rules = await cfg.rules(A);
    const scopes = rules.map((r) => r.scope);
    expect(scopes.indexOf("tenant")).toBeLessThan(scopes.lastIndexOf("user"));
    expect(rules.find((r) => r.scope === "user")!.locked).toBe(false);
  });
});

describe("identity", () => {
  test("api tokens: verify, revoke", async () => {
    const { id, token } = await ids.createApiToken({
      tenantId: A.tenantId,
      userId: A.userId,
      name: "cli",
    });
    expect(token.startsWith("exa_")).toBe(true);
    expect((await ids.verifyApiToken(token))!.userId).toBe(A.userId);
    expect(await ids.verifyApiToken(`${token}x`)).toBeNull();
    expect(await ids.revokeApiToken(A.tenantId, A.userId, id)).toBe(true);
    expect(await ids.verifyApiToken(token)).toBeNull();
    const dump = await db.query<any>("select token_hash from api_tokens");
    expect(JSON.stringify(dump)).not.toContain(token);
  });

  test("device code flow: pending → approved once → consumed", async () => {
    const dc = await ids.createDeviceCode("exa-cli on laptop");
    expect((await ids.pollDeviceCode(dc.deviceCode)).status).toBe("pending");
    expect(await ids.approveDeviceCode(dc.userCode.toLowerCase(), A.tenantId, A.userId)).toBe(true);
    const r = await ids.pollDeviceCode(dc.deviceCode);
    expect(r).toMatchObject({ status: "approved", userId: A.userId });
    expect((await ids.pollDeviceCode(dc.deviceCode)).status).toBe("expired");
  });
});

describe("leases", () => {
  test("one holder at a time; stale fencing rejected; expiry lets others in", async () => {
    const s = mkSession(A, "none", "client");
    await sessions.create(s);
    const f1 = await sessions.acquireLease(
      A.tenantId,
      s.id,
      { type: "device", id: "laptop" },
      30_000,
    );
    expect(f1).toBe(1);
    expect(
      await sessions.acquireLease(A.tenantId, s.id, { type: "server", id: "node1" }, 30_000),
    ).toBeNull();
    const f2 = await sessions.acquireLease(
      A.tenantId,
      s.id,
      { type: "device", id: "laptop" },
      30_000,
    );
    expect(f2).toBe(2);
    expect(
      await sessions.renewLease(A.tenantId, s.id, { type: "device", id: "laptop" }, 1, 30_000),
    ).toBe(false);
    expect(
      await sessions.renewLease(A.tenantId, s.id, { type: "device", id: "laptop" }, 2, 30_000),
    ).toBe(true);
    await db.withTenant(A.tenantId, (q) =>
      q.query(
        `update session_leases set expires_at = now() - interval '1 second' where session_id = $1`,
        [s.id],
      ),
    );
    expect(
      await sessions.acquireLease(A.tenantId, s.id, { type: "server", id: "node1" }, 30_000),
    ).toBe(3);
  });
});

describe("content", () => {
  test("a stored step with no parts keeps its message", async () => {
    const s = mkSession(A, "server", "client");
    await sessions.create(s);
    const info = {
      id: newId(),
      sessionId: s.id,
      parentId: null,
      role: "assistant",
      time: { created: Date.now() },
    } as unknown as MessageInfo;
    await sessions.putStep(A.tenantId, info, []);
    const stored = await sessions.messages(A.tenantId, s.id);
    expect(stored.map((m) => [m.info.id, m.parts.length])).toEqual([[info.id, 0]]);
  });
});

describe("storage modes with the real loop", () => {
  const echo = defineTool({
    name: "echo",
    description: "e",
    schema: z.object({ m: z.string() }),
    readonly: true,
    permissions: () => [],
    execute: async (i) => ({ output: i.m, title: i.m }),
  });
  const run = async (mode: SessionInfo["storageMode"]) => {
    const store = new ServerSessionStore(sessions, A.tenantId);
    const loop = new AgentLoop({
      model: new ScriptedModel([toolCall("echo", { m: "x" }), text("done")]),
      store,
      events: new EventBus(),
      tools: new ToolRegistry([echo]),
      agents: new AgentRegistry(),
      permissions: {
        rules: builtinRules,
        mode: () => "default",
        approvals: { request: async () => "reject" },
      },
      env: () => ({
        root: "/",
        cwd: "/",
        platform: "t",
        date: "d",
        isGitRepo: false,
        host: "server",
      }),
      outputDir: tmpdir(),
      config: { autoTitle: false },
    });
    const s = mkSession(A, mode);
    await store.createSession(s);
    const r = await loop.prompt({ sessionId: s.id, text: "hello" });
    expect(r.text).toBe("done");
    const n = await db.withTenant(A.tenantId, (q) =>
      q.query<{ m: number; p: number }>(
        `select (select count(*)::int from messages where session_id = $1) as m, (select count(*)::int from parts where session_id = $1) as p`,
        [s.id],
      ),
    );
    const meta = await sessions.get(A.tenantId, s.id);
    return { rows: n[0], meta, history: await store.messages(s.id), s };
  };

  test("none: zero content rows in Postgres, metadata (tokens/cost) still recorded", async () => {
    const { rows, meta, history } = await run("none");
    expect(rows).toEqual({ m: 0, p: 0 });
    expect(meta!.tokens.input).toBeGreaterThan(0);
    expect(history.length).toBe(3); // served from memory while the runtime lives
  });

  test("server: messages and final parts persisted, reload matches", async () => {
    const { rows, history } = await run("server");
    expect(rows.m).toBe(3);
    expect(rows.p).toBeGreaterThan(5);
    const tool = history[1].parts.find((p) => p.type === "tool");
    expect(tool && tool.type === "tool" && tool.state.status).toBe("completed");
  });

  test("forget deletes the session and its content", async () => {
    const { s } = await run("server");
    expect(await sessions.delete(A.tenantId, s.id)).toBe(true);
    const n = await db.withTenant(A.tenantId, (q) =>
      q.query<{ n: number }>(`select count(*)::int as n from parts where session_id = $1`, [s.id]),
    );
    expect(n[0].n).toBe(0);
  });
});

describe("keys + telemetry", () => {
  test("BYOK ciphertext only; user key wins over tenant key", async () => {
    const enc = new TextEncoder();
    await cfg.putKey(A, {
      ownerScope: "tenant",
      provider: "openai",
      ciphertext: enc.encode("T-CIPHER"),
      wrappedDek: new Uint8Array(4),
      keyVersion: 1,
      last4: "aaaa",
    });
    await cfg.putKey(A, {
      ownerScope: "user",
      provider: "openai",
      ciphertext: enc.encode("U-CIPHER"),
      wrappedDek: new Uint8Array(4),
      keyVersion: 1,
      last4: "bbbb",
    });
    const k = await cfg.findKey(A, "openai");
    expect(new TextDecoder().decode(k!.ciphertext)).toBe("U-CIPHER");
    expect((await cfg.listKeys(A)).length).toBe(2);
    expect(await cfg.findKey(B, "openai")).toBeNull();
  });

  test("usage batches into partitions + rollups; quotas enforce", async () => {
    await db.query("select exa_ensure_partitions(1)");
    const tw = new TelemetryWriter(db);
    for (let i = 0; i < 5; i++) {
      tw.recordUsage({
        tenantId: A.tenantId,
        userId: A.userId,
        modelRequested: "exa",
        modelUsed: "groq/x",
        keySource: "pool",
        input: 100,
        output: 10,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0.01,
        latencyMs: 5,
        status: "ok",
        time: Date.now(),
      });
    }
    tw.recordAudit({
      tenantId: A.tenantId,
      actorUserId: A.userId,
      action: "tool.run",
      target: "bash",
      decision: "allow",
    });
    await tw.flush();
    const sum = await tw.usageSummary(A.tenantId);
    expect(sum[0].requests).toBe(5);
    expect((await tw.auditTrail(A.tenantId)).length).toBe(1);
    expect(await cfg.quotaExceeded(A.tenantId, A.userId)).toBeNull();
    await cfg.setQuota(A.tenantId, {
      subjectScope: "user",
      subjectId: A.userId,
      period: "day",
      maxRequests: 5,
    });
    expect(await cfg.quotaExceeded(A.tenantId, A.userId)).toContain("request quota");
    expect(await cfg.quotaExceeded(B.tenantId, B.userId)).toBeNull();
  });
});
