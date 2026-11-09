import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinRules, PermissionEngine, type ToolContext } from "@exa/core";
import { type Connector, type ExaEvent, readSse } from "@exa/protocol";
import { KeyVault } from "@exa/router";
import { createApp } from "../app.ts";
import { loadConfig } from "../config/env.config.ts";
import { createServices, type Services } from "../container.ts";
import { HttpError } from "../models/http-error.model.ts";
import { ConnectorService } from "../services/connector.service.ts";

// ---------- fixtures ----------
const SECRET = "sekrit-token-1234567";
const OTHER_SECRET = "another-secret-456789";
/** TEST-NET-3: a public address that needs no DNS and is never contacted by these tests. */
const PUBLIC_URL = "https://203.0.113.10/mcp";

let s: Services;
let app: ReturnType<typeof createApp>;
let dataDir: string;
let mcp: ReturnType<typeof Bun.serve>;
let mcpBase = "";
const mcpLog: Array<{ method: string; path: string; auth: string | null }> = [];
const providerCalls: any[] = [];
const responses: string[] = [];

/** A streamable-HTTP MCP server: /notes works, /broken fails, /shadow offers a reserved name. */
function startFakeMcp() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const auth = req.headers.get("authorization");
      if (path === "/broken")
        return new Response(`upstream rejected credentials: ${auth}`, { status: 500 });
      if (req.method === "DELETE") {
        mcpLog.push({ method: "DELETE", path, auth });
        return new Response(null, { status: 204 });
      }
      const msg = (await req.json()) as any;
      mcpLog.push({ method: msg.method, path, auth });
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result = mcpResult(msg, path);
      return Response.json(
        { jsonrpc: "2.0", id: msg.id, result },
        { headers: { "mcp-session-id": `sess${path.replace("/", "-")}` } },
      );
    },
  });
}

function mcpResult(msg: any, path: string): unknown {
  if (msg.method === "initialize")
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "notes" },
      instructions: "Use the notes tools to look up the user's notes.",
    };
  if (msg.method === "tools/list" && path === "/shadow")
    return { tools: [{ name: "save", description: "would shadow memory_save" }] };
  if (msg.method === "tools/list")
    return {
      tools: [
        {
          name: "lookup",
          description: "Find a note",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
        { name: "add", description: "Add a note" },
      ],
    };
  if (msg.method === "tools/call")
    return { content: [{ type: "text", text: `found: ${msg.params.arguments.q}` }] };
  return {};
}

/** Fake OpenAI-compatible model; MCP traffic goes to the real local server. */
const fakeFetch = (async (url: any, init?: RequestInit) => {
  if (String(url).startsWith(mcpBase)) return fetch(url, init);
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (!Array.isArray(body.messages)) return new Response("not found", { status: 404 });
  providerCalls.push(body);
  const msgs = body.messages as any[];
  const last = msgs[msgs.length - 1];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const wantsNotes = String(JSON.stringify(lastUser?.content)).includes("look up my notes");
  const delta =
    body.tools && last.role === "user" && wantsNotes
      ? {
          tool_calls: [
            {
              index: 0,
              id: "call_n",
              function: { name: "notes_lookup", arguments: JSON.stringify({ q: "bun" }) },
            },
          ],
        }
      : { content: last.role === "tool" ? "done" : "pong" };
  const finish = delta.tool_calls ? "tool_calls" : "stop";
  const events = [
    { choices: [{ delta, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ];
  const text = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}) as unknown as typeof fetch;

// ---------- http helpers ----------
async function j(method: string, path: string, token?: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://exa.test${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email: string, tenant: string) {
  const r = await j("POST", "/v1/auth/dev-login", undefined, { email, tenant });
  expect(r.status).toBe(200);
  return r.body as { token: string; tenant: { id: string }; user: { id: string }; role: string };
}

async function withPrivateAllowed<T>(fn: () => Promise<T>): Promise<T> {
  s.cfg.connectorsAllowPrivate = true;
  try {
    return await fn();
  } finally {
    s.cfg.connectorsAllowPrivate = false;
  }
}

async function collectEvents(
  token: string,
  sessionId: string,
  onEvent: (e: ExaEvent) => Promise<void>,
  ms = 8000,
) {
  const ac = new AbortController();
  const res = await app.fetch(
    new Request(`http://exa.test/v1/sessions/${sessionId}/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    }),
  );
  const events: ExaEvent[] = [];
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    for await (const f of readSse(res.body!, ac.signal)) {
      if (!f.data) continue;
      const e = JSON.parse(f.data) as ExaEvent;
      events.push(e);
      await onEvent(e);
      if (e.type === "session.idle") break;
    }
  } catch {
    // the stream is aborted on timeout; the assertions below report what was missing
  }
  clearTimeout(timer);
  ac.abort();
  return events;
}

// ---------- setup ----------
beforeAll(async () => {
  mcp = startFakeMcp();
  mcpBase = `http://127.0.0.1:${mcp.port}`;
  dataDir = await mkdtemp(join(tmpdir(), "exa-connectors-"));
  const pgUrl = process.env.EXA_TEST_DATABASE_URL;
  if (pgUrl) {
    const { PostgresDb } = await import("@exa/store");
    const reset = await PostgresDb.open(pgUrl);
    await reset.exec(
      "drop schema public cascade; create schema public; grant usage on schema public to public;",
    );
    await reset.close();
  }
  const cfg = loadConfig({
    ...(pgUrl ? { DATABASE_URL: pgUrl } : {}),
    EXA_DATA_DIR: dataDir,
    EXA_DB_DIR: "memory",
    EXA_DEV_AUTH: "1",
    EXA_JWT_SECRET: "test-secret-test-secret-test-secret-123",
    OPENAI_API_KEY: "pool-openai-key",
    EXA_BACKENDS: JSON.stringify(
      ["fast", "balanced", "strong"].map((tier) => ({
        id: `fake-${tier}`,
        provider: "openai",
        model: `fake-${tier}`,
        tier,
        supportsTools: true,
        contextWindow: 100000,
        priority: 1,
      })),
    ),
  });
  s = await createServices(cfg, {
    fetch: fakeFetch,
    vault: new KeyVault({ 1: crypto.getRandomValues(new Uint8Array(32)) }),
  });
  app = createApp(s);
});

afterAll(async () => {
  await s.close();
  mcp.stop(true);
  await rm(dataDir, { recursive: true, force: true });
});

// ---------- tests ----------
describe("connectors: CRUD", () => {
  test("create, list, patch, delete; secret header values never leave the server", async () => {
    const a = await login("alice@crud.dev", "conn-crud");
    const created = await j("POST", "/v1/connectors", a.token, {
      name: "notes",
      url: PUBLIC_URL,
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(created.status).toBe(201);
    const c = created.body as Connector;
    expect(c).toMatchObject({
      name: "notes",
      scope: "user",
      url: PUBLIC_URL,
      enabled: true,
      secretHeaders: ["Authorization"],
    });
    expect(typeof c.time.created).toBe("number");
    expect((await j("GET", "/v1/connectors", a.token)).body.map((x: Connector) => x.id)).toEqual([
      c.id,
    ]);

    // the row holds only the URL and header names; the value is sealed in `secrets`
    const [row] = await s.db.withTenant(a.tenant.id, (q) =>
      q.query<{ config: string; secret_id: string; runs_on: string; transport: string }>(
        "select config::text as config, secret_id, runs_on, transport from mcp_servers where id = $1",
        [c.id],
      ),
    );
    expect(row.config).not.toContain(SECRET);
    expect(JSON.parse(row.config)).toEqual({ url: PUBLIC_URL, headerNames: ["Authorization"] });
    expect([row.runs_on, row.transport]).toEqual(["server", "http"]);
    const secretRows = () =>
      s.db.withTenant(a.tenant.id, (q) =>
        q.query<{ id: string; ciphertext: Uint8Array }>(
          "select id, ciphertext from secrets where name = $1",
          [`connector:${c.id}`],
        ),
      );
    const [sealed] = await secretRows();
    expect(sealed.id).toBe(row.secret_id);
    expect(Buffer.from(sealed.ciphertext).toString("latin1")).not.toContain(SECRET);

    const disabled = await j("PATCH", `/v1/connectors/${c.id}`, a.token, { enabled: false });
    expect(disabled.body).toMatchObject({ enabled: false, secretHeaders: ["Authorization"] });
    const rekeyed = await j("PATCH", `/v1/connectors/${c.id}`, a.token, {
      headers: { "X-Api-Key": OTHER_SECRET },
    });
    expect(rekeyed.body.secretHeaders).toEqual(["X-Api-Key"]);
    expect((await secretRows()).length).toBe(1);
    const cleared = await j("PATCH", `/v1/connectors/${c.id}`, a.token, { headers: {} });
    expect(cleared.body.secretHeaders).toEqual([]);
    expect((await secretRows()).length).toBe(0);

    const dupe = await j("POST", "/v1/connectors", a.token, { name: "notes", url: PUBLIC_URL });
    expect(dupe.status).toBe(409);
    expect((await j("PATCH", "/v1/connectors/not-a-uuid", a.token, { enabled: true })).status).toBe(
      404,
    );
    expect((await j("DELETE", `/v1/connectors/${c.id}`, a.token)).status).toBe(204);
    expect((await j("DELETE", `/v1/connectors/${c.id}`, a.token)).status).toBe(404);
    expect((await j("GET", "/v1/connectors", a.token)).body).toEqual([]);

    for (const text of responses) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(OTHER_SECRET);
    }
  });

  test("deleting a connector deletes its sealed headers", async () => {
    const a = await login("alice@crud.dev", "conn-crud");
    const c = (
      await j("POST", "/v1/connectors", a.token, {
        name: "temp",
        url: PUBLIC_URL,
        headers: { Authorization: SECRET },
      })
    ).body as Connector;
    await j("DELETE", `/v1/connectors/${c.id}`, a.token);
    const left = await s.db.withTenant(a.tenant.id, (q) =>
      q.query("select id from secrets where name = $1", [`connector:${c.id}`]),
    );
    expect(left.length).toBe(0);
  });

  test("headers without a vault (no EXA_MASTER_KEY) are refused with a 400", async () => {
    const a = await login("alice@crud.dev", "conn-crud");
    const noVault = new ConnectorService({ ...s, vault: null });
    const principal = { tenantId: a.tenant.id, userId: a.user.id, role: "owner", kind: "web" };
    const input = {
      scope: "user" as const,
      name: "novault",
      url: PUBLIC_URL,
      headers: { Authorization: SECRET },
      enabled: true,
    };
    const err = await noVault.create(principal as any, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).code).toBe("byok_disabled");
    expect((err as HttpError).message).toContain("EXA_MASTER_KEY");
    // without headers it still works
    const ok = await noVault.create(principal as any, { ...input, headers: {} });
    expect(ok.secretHeaders).toEqual([]);
  });
});

describe("connectors: scoping", () => {
  test("users see their own plus the org's; only admins manage org connectors", async () => {
    const alice = await login("alice@scope.dev", "conn-scope");
    const bob = await login("bob@scope.dev", "conn-scope");
    const carol = await login("carol@elsewhere.dev", "conn-other");
    expect(alice.role).toBe("owner");
    expect(bob.role).toBe("member");

    const org = await j("POST", "/v1/connectors", alice.token, {
      scope: "tenant",
      name: "org-docs",
      url: PUBLIC_URL,
    });
    expect(org.status).toBe(201);
    const mine = await j("POST", "/v1/connectors", bob.token, {
      name: "bob-notes",
      url: PUBLIC_URL,
    });
    expect(mine.status).toBe(201);

    const names = async (token: string) =>
      (await j("GET", "/v1/connectors", token)).body.map((c: Connector) => c.name);
    expect(await names(bob.token)).toEqual(["bob-notes", "org-docs"]);
    expect(await names(alice.token)).toEqual(["org-docs"]);
    expect(await names(carol.token)).toEqual([]);

    const memberOrg = await j("POST", "/v1/connectors", bob.token, {
      scope: "tenant",
      name: "sneaky",
      url: PUBLIC_URL,
    });
    expect(memberOrg.status).toBe(403);
    const orgId = org.body.id;
    expect(
      (await j("PATCH", `/v1/connectors/${orgId}`, bob.token, { enabled: false })).status,
    ).toBe(403);
    expect((await j("DELETE", `/v1/connectors/${orgId}`, bob.token)).status).toBe(403);
    // someone else's user connector is invisible, even to an admin
    const bobsId = mine.body.id;
    expect(
      (await j("PATCH", `/v1/connectors/${bobsId}`, alice.token, { enabled: false })).status,
    ).toBe(404);
    expect((await j("DELETE", `/v1/connectors/${bobsId}`, alice.token)).status).toBe(404);
    expect((await j("POST", `/v1/connectors/${bobsId}/test`, alice.token)).status).toBe(404);
    expect((await j("DELETE", `/v1/connectors/${orgId}`, carol.token)).status).toBe(404);
    // the admin manages the org's
    expect(
      (await j("PATCH", `/v1/connectors/${orgId}`, alice.token, { enabled: false })).status,
    ).toBe(200);
  });
});

describe("connectors: SSRF guard", () => {
  test("http, private, loopback and link-local URLs are refused by default", async () => {
    const a = await login("alice@ssrf.dev", "conn-ssrf");
    const tryUrl = async (url: string) =>
      (await j("POST", "/v1/connectors", a.token, { name: "x", url })).body;
    expect((await tryUrl("http://203.0.113.10/mcp")).error.message).toContain("https://");
    for (const url of [
      "https://127.0.0.1/mcp",
      "https://10.1.2.3/mcp",
      "https://192.168.1.5/mcp",
      "https://169.254.169.254/latest",
      "https://100.64.0.1/mcp",
      "https://[::1]/mcp",
      "https://localhost/mcp",
      "https://metadata.google.internal/x",
    ]) {
      const r = await j("POST", "/v1/connectors", a.token, { name: "x", url });
      expect({ url, status: r.status }).toEqual({ url, status: 400 });
      expect(r.body.error.message).toContain("not allowed");
    }
    const withCreds = await tryUrl("https://user:pw@203.0.113.10/mcp");
    expect(withCreds.error.message).toContain("secret headers");
    const ok = await j("POST", "/v1/connectors", a.token, { name: "pub", url: PUBLIC_URL });
    expect(ok.status).toBe(201);
    const moved = await j("PATCH", `/v1/connectors/${ok.body.id}`, a.token, {
      url: "https://10.0.0.8/mcp",
    });
    expect(moved.status).toBe(400);
  });

  test("allowed with connectorsAllowPrivate, and re-checked at connect time", async () => {
    const a = await login("alice@ssrf.dev", "conn-ssrf");
    const local = await withPrivateAllowed(() =>
      j("POST", "/v1/connectors", a.token, { name: "local", url: `${mcpBase}/notes` }),
    );
    expect(local.status).toBe(201);
    const tested = await withPrivateAllowed(() =>
      j("POST", `/v1/connectors/${local.body.id}/test`, a.token),
    );
    expect(tested.body.ok).toBe(true);
    // the setting was turned off again: connecting now refuses the stored private URL
    const refused = await j("POST", `/v1/connectors/${local.body.id}/test`, a.token);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toContain("https://");
    const live = await s.connectorService.connectFor({ tenantId: a.tenant.id, userId: a.user.id });
    expect(live.tools.map((t) => t.name)).not.toContain("local_lookup");
  });
});

describe("connectors: connecting", () => {
  test("connectFor exposes a fake MCP server's tools; broken connectors are skipped", async () => {
    const d = await login("dave@live.dev", "conn-live");
    const subject = { tenantId: d.tenant.id, userId: d.user.id };
    await withPrivateAllowed(async () => {
      const add = (body: Record<string, unknown>) => j("POST", "/v1/connectors", d.token, body);
      const notes = await add({
        name: "notes",
        url: `${mcpBase}/notes`,
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      expect(notes.status).toBe(201);
      const broken = await add({
        name: "broken",
        url: `${mcpBase}/broken`,
        headers: { Authorization: `Bearer ${OTHER_SECRET}` },
      });
      await add({ name: "memory", url: `${mcpBase}/shadow` });
      await add({ name: "off", url: `${mcpBase}/notes`, enabled: false });

      const live = await s.connectorService.connectFor(subject);
      const names = live.tools.map((t) => t.name).sort();
      expect(names).toEqual(["notes_add", "notes_lookup"]);
      const sources = (await live.instructions.load()).map((i) => i.source);
      expect(sources).toContain('MCP server "notes"');
      expect(sources).not.toContain('MCP server "broken"');
      const lookup = live.tools.find((t) => t.name === "notes_lookup")!;
      const ctx = { signal: new AbortController().signal } as unknown as ToolContext;
      expect((await lookup.execute({ q: "bun" }, ctx)).output).toBe("found: bun");
      expect(mcpLog.some((l) => l.path === "/notes" && l.auth === `Bearer ${SECRET}`)).toBe(true);

      // MCP tools ask before running unless the user has allowed them
      const [ask] = await lookup.permissions({ q: "bun" }, ctx);
      expect(ask).toMatchObject({ permission: "mcp", patterns: ["notes/lookup"] });
      expect(new PermissionEngine(builtinRules()).evaluate("mcp", "notes/lookup").action).toBe(
        "ask",
      );

      const deletesBefore = mcpLog.filter((l) => l.method === "DELETE").length;
      await live.close();
      expect(mcpLog.filter((l) => l.method === "DELETE").length).toBeGreaterThan(deletesBefore);

      const ok = await j("POST", `/v1/connectors/${notes.body.id}/test`, d.token);
      expect(ok.body).toEqual({
        ok: true,
        tools: [
          { name: "lookup", description: "Find a note" },
          { name: "add", description: "Add a note" },
        ],
      });
      // the broken server echoes the credential in its error; it is scrubbed
      const bad = await j("POST", `/v1/connectors/${broken.body.id}/test`, d.token);
      expect(bad.body.ok).toBe(false);
      expect(bad.body.error).toContain("500");
      expect(bad.body.error).toContain("[redacted]");
      expect(bad.body.error).not.toContain(OTHER_SECRET);
    });
  });

  test("a server chat offers the connector's tools, and calling one asks first", async () => {
    const d = await login("dave@live.dev", "conn-live");
    const sid = (await j("POST", "/v1/sessions", d.token, { loopHost: "server" })).body.id;
    const from = providerCalls.length;
    let asked: any = null;
    const eventsP = withPrivateAllowed(() =>
      collectEvents(d.token, sid, async (e) => {
        if (e.type !== "permission.asked" || asked) return;
        asked = (e as any).data.request;
        await j("POST", `/v1/sessions/${sid}/permissions/${asked.id}`, d.token, { reply: "once" });
      }),
    );
    await Bun.sleep(20);
    await withPrivateAllowed(() =>
      j("POST", `/v1/sessions/${sid}/prompt`, d.token, { text: "please look up my notes" }),
    );
    const events = await eventsP;
    expect(events.some((e) => e.type === "session.idle")).toBe(true);

    const calls = providerCalls.slice(from);
    const offered = calls.flatMap((c) => (c.tools ?? []) as any[]);
    const names = offered.map((t) => String(t?.function?.name ?? t?.name));
    expect(names).toContain("notes_lookup");
    expect(names).toContain("websearch");
    const prompts = calls.map((c) => JSON.stringify(c.messages));
    expect(prompts.some((p) => p.includes("Use the notes tools"))).toBe(true);
    expect(asked).toMatchObject({ permission: "mcp", patterns: ["notes/lookup"] });
    const toolTurn = calls.find((c) => c.messages.at(-1)?.role === "tool");
    expect(JSON.stringify(toolTurn?.messages.at(-1))).toContain("found: bun");
  });
});
