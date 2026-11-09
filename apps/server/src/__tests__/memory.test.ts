import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModel, text, toolCall } from "@exa/core";
import {
  type ChatSearchHit,
  type MemoryItem,
  type MessageInfo,
  type ModelRequest,
  newId,
  type Part,
  type Role,
  zeroTokens,
} from "@exa/protocol";
import type { Gateway } from "@exa/router";
import { memories, messages, parts } from "@exa/store";
import { createApp } from "../app.ts";
import { loadConfig } from "../config/env.config.ts";
import { createServices, type Services } from "../container.ts";
import { HIT_START, HIT_STOP } from "../helpers/snippet.helper.ts";
import type { Principal } from "../models/principal.model.ts";
import { ServerRuntime } from "../runtime/server-runtime.ts";
import { MAX_MEMORIES_PER_USER } from "../services/memory.service.ts";

interface Login {
  token: string;
  tenant: { id: string };
  user: { id: string };
  role: string;
}

let s: Services;
let app: ReturnType<typeof createApp>;
let dataDir: string;
/** What the fake provider received (OpenAI chat-completions shape). */
interface ProviderBody {
  messages: unknown[];
  tools?: Array<{ function: { name: string } }>;
}

const providerBodies: ProviderBody[] = [];

// Fake OpenAI-compatible provider: records each request and answers "ok".
const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
  providerBodies.push(JSON.parse(String(init?.body ?? "{}")));
  const events = [
    { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } },
  ];
  const body = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}) as unknown as typeof fetch;

const j = async (method: string, path: string, token?: string, body?: unknown) => {
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
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
};

async function login(email: string, tenant: string): Promise<Login> {
  const r = await j("POST", "/v1/auth/dev-login", undefined, { email, tenant });
  expect(r.status).toBe(200);
  return r.body;
}

const owner = (l: Login) => ({ tenantId: l.tenant.id, userId: l.user.id });

async function createChat(l: Login, fields: Record<string, unknown> = {}): Promise<string> {
  const r = await j("POST", "/v1/sessions", l.token, { loopHost: "server", ...fields });
  expect(r.status).toBe(201);
  return r.body.id;
}

/** Stores one message with a single text part, as the loop would. */
async function storeText(
  l: Login,
  sessionId: string,
  role: Role,
  body: string,
  extra: { synthetic?: boolean } = {},
): Promise<string> {
  const tenantId = l.tenant.id;
  const messageId = newId();
  const info: MessageInfo = {
    id: messageId,
    sessionId,
    parentId: null,
    role,
    agent: "assistant",
    model: "exa",
    time: { created: Date.now() },
    tokens: zeroTokens(),
    cost: 0,
  };
  const part: Part = { id: newId(), sessionId, messageId, type: "text", text: body, ...extra };
  await s.db.withTenant(tenantId, async (q) => {
    await q.orm.insert(messages).values({ id: messageId, tenantId, sessionId, role, data: info });
    await q.orm
      .insert(parts)
      .values({ id: part.id, tenantId, sessionId, messageId, type: "text", data: part });
  });
  return messageId;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "exa-memory-"));
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
  s = await createServices(cfg, { fetch: fakeFetch, vault: null });
  app = createApp(s);
});

afterAll(async () => {
  await s.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("memory repository", () => {
  test("a memory is visible only to its user, and only inside its tenant", async () => {
    const alice = await login("alice@acme.dev", "acme");
    const bob = await login("bob@acme.dev", "acme");
    const carol = await login("carol@globex.dev", "globex");
    expect(bob.tenant.id).toBe(alice.tenant.id);
    const a = owner(alice);
    const b = owner(bob);
    const mem = await s.memories.create(a.tenantId, a.userId, { topic: "diet", content: "veg" });
    expect(await s.memories.get(a.tenantId, a.userId, mem.id)).toMatchObject({ content: "veg" });
    // same tenant, other user: nothing to see, change or delete
    expect(await s.memories.list(b.tenantId, b.userId, 10)).toEqual([]);
    expect(await s.memories.get(b.tenantId, b.userId, mem.id)).toBeNull();
    const fields = { topic: "x", content: "y" };
    expect(await s.memories.update(b.tenantId, b.userId, mem.id, fields)).toBeNull();
    expect(await s.memories.delete(b.tenantId, b.userId, mem.id)).toBe(false);
    expect(await s.memories.count(b.tenantId, b.userId)).toBe(0);
    // other tenant, even with alice's user id: RLS hides the row
    expect(await s.memories.get(carol.tenant.id, a.userId, mem.id)).toBeNull();
    expect(await s.memories.list(carol.tenant.id, a.userId, 10)).toEqual([]);
    expect(await s.memories.count(a.tenantId, a.userId)).toBe(1);
    expect(await s.memories.delete(a.tenantId, a.userId, mem.id)).toBe(true);
  });

  test("update keeps the source chat unless one is given, and bumps updated time", async () => {
    const a = owner(await login("alice@acme.dev", "acme"));
    const source = newId();
    const mem = await s.memories.create(a.tenantId, a.userId, {
      topic: "pets",
      content: "has a cat",
      sourceSessionId: source,
    });
    const edited = await s.memories.update(a.tenantId, a.userId, mem.id, {
      topic: "pets",
      content: "has two cats",
    });
    expect(edited!.sourceSessionId).toBe(source);
    expect(edited!.time.updated).toBeGreaterThanOrEqual(mem.time.updated);
    expect((await s.memories.list(a.tenantId, a.userId, 1))[0].id).toBe(mem.id);
  });

  test("search is an OR over the words, ranked by how many match", async () => {
    const erin = owner(await login("erin@acme.dev", "acme"));
    const add = (topic: string, content: string) =>
      s.memories.create(erin.tenantId, erin.userId, { topic, content });
    const both = await add("breakfast", "Eggs and toast every morning");
    const eggsOnly = await add("diet", "Allergic to eggs");
    const breakfastOnly = await add("routine", "Skips breakfast on weekends");
    await add("music", "Likes jazz");
    const hits = await s.memories.search(erin.tenantId, erin.userId, "eggs breakfast", 10);
    expect(hits[0].id).toBe(both.id);
    expect(new Set(hits.map((m) => m.id))).toEqual(
      new Set([both.id, eggsOnly.id, breakfastOnly.id]),
    );
    expect((await s.memories.search(erin.tenantId, erin.userId, "jazz", 10)).length).toBe(1);
  });

  test("search treats tsquery syntax as plain words and never errors", async () => {
    const erin = owner(await login("erin@acme.dev", "acme"));
    const search = (q: string) => s.memories.search(erin.tenantId, erin.userId, q, 10);
    const hostile = await search("eggs) | !(breakfast & ' :* <-> \\");
    const plain = await search("eggs breakfast");
    expect(hostile.map((m) => m.id)).toEqual(plain.map((m) => m.id));
    expect(await search("&&& !!! ()")).toEqual([]);
    expect(await search("the and of")).toEqual([]);
  });
});

describe("chat search", () => {
  test("finds the user's own stored chats with an escaped, highlighted snippet", async () => {
    const alice = await login("alice@acme.dev", "acme");
    const bob = await login("bob@acme.dev", "acme");
    const carol = await login("carol@globex.dev", "globex");
    const trip = await createChat(alice, { title: "Trip planning" });
    // Postgres drops what it parses as a tag (<script>); the broken <img survives and is escaped
    const injected = `${HIT_START}sneaky${HIT_STOP}`;
    const userText = `My passport <img src=x onerror=alert(1)// expires <script>alert(2)</script> in May ${injected} & "soon"`;
    const userMsg = await storeText(alice, trip, "user", userText);
    const answer = await storeText(alice, trip, "assistant", "Renew the passport before you go.");
    await storeText(alice, trip, "user", "passport reminder", { synthetic: true });
    const archived = await createChat(alice, { title: "Old" });
    await storeText(alice, archived, "user", "passport photo");
    const patch = await j("PATCH", `/v1/sessions/${archived}`, alice.token, { archived: true });
    expect(patch.status).toBe(200);
    const child = await createChat(alice, { parentId: trip });
    await storeText(alice, child, "user", "subagent passport lookup");
    await storeText(bob, await createChat(bob), "user", "bob's passport");
    await storeText(carol, await createChat(carol), "user", "carol's passport");

    const r = await j("GET", "/v1/search?q=passport", alice.token);
    expect(r.status).toBe(200);
    const hits = r.body as ChatSearchHit[];
    expect(hits.map((h) => h.messageId).sort()).toEqual([userMsg, answer].sort());
    const hit = hits.find((h) => h.messageId === userMsg)!;
    expect(hit).toMatchObject({ sessionId: trip, sessionTitle: "Trip planning", role: "user" });
    expect(typeof hit.time).toBe("number");
    expect(hit.snippet).toStartWith("My <b>passport</b> &lt;img src=x onerror=alert(1)//");
    expect(hit.snippet).toContain("alert(2) in May sneaky &amp; &quot;soon");
    // the only markup is the <b> highlighting; injected marker characters are dropped
    expect(hit.snippet.replace(/<\/?b>/g, "")).not.toMatch(/[<>]/);
    expect(hit.snippet).not.toContain(HIT_START);
    expect(hit.snippet).not.toContain("<b>sneaky</b>");
  });

  test("more matching words rank higher; queries without words find nothing", async () => {
    const alice = await login("alice@acme.dev", "acme");
    const r = await j("GET", "/v1/search?q=renew%20passport&limit=5", alice.token);
    expect(r.body[0].role).toBe("assistant");
    expect(r.body[0].snippet).toContain("<b>Renew</b>");
    expect((await j("GET", "/v1/search?q=%21%21%21", alice.token)).body).toEqual([]);
  });
});

describe("memory API", () => {
  test("create, list, search, update, delete with the right status codes", async () => {
    const frank = await login("frank@acme.dev", "acme");
    const bob = await login("bob@acme.dev", "acme");
    const created = await j("POST", "/v1/memories", frank.token, {
      topic: " family ",
      content: "Sister is called Ana",
    });
    expect(created.status).toBe(201);
    const mem = created.body as MemoryItem;
    expect(mem).toMatchObject({ topic: "family", content: "Sister is called Ana" });
    expect(mem.sourceSessionId).toBeNull();
    expect(typeof mem.time.created).toBe("number");
    await j("POST", "/v1/memories", frank.token, { topic: "work", content: "Starts at 9" });

    const listed = await j("GET", "/v1/memories", frank.token);
    expect(listed.status).toBe(200);
    expect(listed.body.map((m: MemoryItem) => m.topic)).toEqual(["work", "family"]);
    expect((await j("GET", "/v1/memories?limit=1", frank.token)).body.length).toBe(1);
    const found = await j("GET", "/v1/memories?q=sister", frank.token);
    expect(found.body.map((m: MemoryItem) => m.id)).toEqual([mem.id]);
    expect((await j("GET", "/v1/memories?q=", frank.token)).status).toBe(400);

    const edit = { topic: "family", content: "Sister Ana lives in Lisbon" };
    expect((await j("PUT", `/v1/memories/${mem.id}`, bob.token, edit)).status).toBe(404);
    expect((await j("PUT", "/v1/memories/not-a-uuid", frank.token, edit)).status).toBe(404);
    const updated = await j("PUT", `/v1/memories/${mem.id}`, frank.token, edit);
    expect(updated.status).toBe(200);
    expect(updated.body.content).toBe(edit.content);

    expect((await j("DELETE", `/v1/memories/${mem.id}`, bob.token)).status).toBe(404);
    expect((await j("DELETE", `/v1/memories/${mem.id}`, frank.token)).status).toBe(204);
    expect((await j("DELETE", `/v1/memories/${mem.id}`, frank.token)).status).toBe(404);
  });

  test("bad input is 400, no token is 401", async () => {
    const frank = await login("frank@acme.dev", "acme");
    const empty = await j("POST", "/v1/memories", frank.token, { topic: "", content: "x" });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("validation");
    expect((await j("GET", "/v1/search", frank.token)).status).toBe(400);
    expect((await j("GET", "/v1/search?q=x&limit=500", frank.token)).status).toBe(400);
    expect((await j("GET", "/v1/memories")).status).toBe(401);
    expect((await j("GET", "/v1/search?q=x")).status).toBe(401);
  });

  test("the per-user cap is a 409 limit_reached", async () => {
    const gus = await login("gus@acme.dev", "acme");
    const { tenantId, userId } = owner(gus);
    const rows = Array.from({ length: MAX_MEMORIES_PER_USER }, (_, i) => ({
      id: newId(),
      tenantId,
      userId,
      topic: "bulk",
      content: `fact ${i}`,
    }));
    await s.db.withTenant(tenantId, (q) => q.orm.insert(memories).values(rows));
    const r = await j("POST", "/v1/memories", gus.token, { topic: "one", content: "more" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "limit_reached", limit: MAX_MEMORIES_PER_USER });
    // someone else in the same tenant is unaffected
    const frank = await login("frank@acme.dev", "acme");
    const ok = await j("POST", "/v1/memories", frank.token, { topic: "one", content: "more" });
    expect(ok.status).toBe(201);
  });
});

describe("memory port", () => {
  test("save by id only touches the user's own memory; forget ignores foreign ids", async () => {
    const alice = owner(await login("alice@acme.dev", "acme"));
    const bob = owner(await login("bob@acme.dev", "acme"));
    const bobs = await s.memoryService.portFor(bob.tenantId, bob.userId).save({
      topic: "car",
      content: "drives a van",
    });
    const port = s.memoryService.portFor(alice.tenantId, alice.userId);
    await expect(port.save({ id: bobs.id, topic: "car", content: "mine" })).rejects.toThrow(
      "memory not found",
    );
    await expect(port.save({ id: "garbage", topic: "car", content: "x" })).rejects.toThrow();
    expect(await port.forget(bobs.id)).toBe(false);
    expect(await port.forget("garbage")).toBe(false);
    expect((await s.memories.get(bob.tenantId, bob.userId, bobs.id))!.content).toBe("drives a van");
  });
});

describe("server loop with memory", () => {
  test("the chat sees saved memories in its prompt and memory_save persists a row", async () => {
    const hana = await login("hana@acme.dev", "acme");
    const { tenantId, userId } = owner(hana);
    const known = await s.memoryService.create(
      { tenantId, userId },
      {
        topic: "diet",
        content: "Vegetarian since 2019",
      },
    );
    const model = new ScriptedModel([
      toolCall("memory_save", { topic: "coffee", content: "Takes oat milk" }),
      text("Noted."),
    ]);
    const gateway = {
      stream: (_p: unknown, req: ModelRequest, signal: AbortSignal) => model.stream(req, signal),
    } as unknown as Gateway;
    const runtime = new ServerRuntime({
      ...s,
      gateway,
      memoryFor: (t, u) => s.memoryService.portFor(t, u),
    });
    const sid = await createChat(hana, { title: "Coffee" });
    const session = (await j("GET", `/v1/sessions/${sid}`, hana.token)).body.info;
    const principal: Principal = { tenantId, userId, role: "member", kind: "web" };
    try {
      const result = await runtime.run(principal, session, { text: "I take oat milk" });
      expect(result.text).toBe("Noted.");
    } finally {
      await runtime.shutdown();
    }
    const first = model.requests[0];
    expect(first.system).toContain("<memory>");
    expect(first.system).toContain(`[${known.id}] diet: Vegetarian since 2019`);
    expect(first.tools!.map((t) => t.name)).toEqual(
      expect.arrayContaining(["memory_save", "memory_forget", "recall"]),
    );
    const saved = (await s.memories.list(tenantId, userId, 10)).find((m) => m.topic === "coffee");
    expect(saved).toMatchObject({ content: "Takes oat milk", sourceSessionId: sid });
  });

  test("the container wires memory into web chats", async () => {
    const ivy = await login("ivy@acme.dev", "acme");
    await j("POST", "/v1/memories", ivy.token, { topic: "home", content: "Lives in Porto" });
    const sid = await createChat(ivy, { title: "Hello" });
    providerBodies.length = 0;
    expect((await j("POST", `/v1/sessions/${sid}/prompt`, ivy.token, { text: "hi" })).status).toBe(
      202,
    );
    const chatRequest = () => providerBodies.find((b) => b.tools);
    for (let i = 0; i < 200 && (!chatRequest() || s.runtime.isBusy(sid)); i++) await Bun.sleep(10);
    const sent = chatRequest()!;
    expect(JSON.stringify(sent.messages)).toContain("home: Lives in Porto");
    expect(sent.tools!.map((t) => t.function.name)).toContain("memory_save");
  });
});
