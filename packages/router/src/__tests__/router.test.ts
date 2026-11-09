import { describe, expect, test } from "bun:test";
import type { ModelChunk, ModelRequest } from "@exa/protocol";
import {
  type Backend,
  classify,
  costFor,
  EventStreamDecoder,
  ExaRouter,
  Gateway,
  type GatewayPorts,
  KeyVault,
  signV4,
  streamAnthropic,
  streamBedrock,
  streamOpenAI,
  toConverse,
  type UsageRecord,
} from "../index.ts";

const sse = (events: unknown[]) =>
  new Response(
    events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );

const collect = async (g: AsyncIterable<ModelChunk>) => {
  const out: ModelChunk[] = [];
  for await (const c of g) out.push(c);
  return out;
};

const req: ModelRequest = {
  model: "x",
  system: "sys",
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", callId: "c1", name: "read", input: { filePath: "a" } }],
    },
    {
      role: "user",
      content: [{ type: "tool-result", callId: "c1", name: "read", output: "content" }],
    },
  ],
  tools: [{ name: "read", description: "r", parameters: { type: "object", properties: {} } }],
};

describe("openai-compatible adapter", () => {
  test("maps messages and streams text + accumulated tool calls + usage", async () => {
    let body: any;
    const fetchFn = async (_u: any, init?: RequestInit) => {
      body = JSON.parse(String(init!.body));
      return sse([
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read", arguments: '{"filePath":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"x.ts"}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        },
        "[DONE]",
      ]);
    };
    const out = await collect(
      streamOpenAI(req, {
        model: "gpt",
        key: "k",
        baseURL: "https://x/v1",
        fetch: fetchFn,
        signal: new AbortController().signal,
        providerId: "openai",
      }),
    );
    expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[2].tool_calls[0].function.arguments).toBe('{"filePath":"a"}');
    expect(body.stream_options.include_usage).toBe(true);
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.text)
      .join("");
    expect(text).toBe("Hello");
    expect(out.find((c) => c.type === "tool-call")).toEqual({
      type: "tool-call",
      callId: "call_1",
      name: "read",
      input: { filePath: "x.ts" },
    });
    const fin = out.at(-1) as any;
    expect(fin.reason).toBe("tool-calls");
    expect(fin.usage).toEqual({ input: 100, output: 7, reasoning: 0, cacheRead: 20 });
  });

  test("HTTP errors become retryable ModelErrors without leaking the key", async () => {
    const fetchFn = async () => new Response("rate limited", { status: 429 });
    await expect(
      collect(
        streamOpenAI(req, {
          model: "m",
          key: "sk-secret",
          baseURL: "https://x",
          fetch: fetchFn,
          signal: new AbortController().signal,
          providerId: "groq",
        }),
      ),
    ).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
  });

  test("low credits (402 'can only afford N') retries once with a budget that fits", async () => {
    const budgets: number[] = [];
    const lowCredit = JSON.stringify({
      error: {
        message:
          "This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 1366.",
        code: 402,
      },
    });
    const fetchFn = async (_u: any, init?: RequestInit) => {
      const max = JSON.parse(String(init!.body)).max_tokens;
      budgets.push(max);
      if (max > 1366) return new Response(lowCredit, { status: 402 });
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]);
    };
    const opts = { model: "m", baseURL: "https://x", signal: new AbortController().signal };
    const out = await collect(
      streamOpenAI(
        { ...req, maxTokens: 8192 },
        { ...opts, fetch: fetchFn, providerId: "openrouter" },
      ),
    );
    expect(budgets).toEqual([8192, 1229]);
    expect(out.some((c) => c.type === "text-delta" && c.text === "ok")).toBe(true);
  });

  test("errors carry the provider's message, not its raw JSON", async () => {
    const body = JSON.stringify({ error: { message: "can only afford 100", code: 402 } });
    const fetchFn = async () => new Response(body, { status: 402 });
    const opts = { model: "m", baseURL: "https://x", signal: new AbortController().signal };
    const run = collect(streamOpenAI(req, { ...opts, fetch: fetchFn, providerId: "openrouter" }));
    // 100 tokens is too small to retry with, so the error surfaces, readable
    await expect(run).rejects.toMatchObject({
      status: 402,
      message: "openrouter 402: can only afford 100",
    });
  });

  test("no tools → tool blocks flattened to text", async () => {
    let body: any;
    const fetchFn = async (_u: any, init?: RequestInit) => {
      body = JSON.parse(String(init!.body));
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]);
    };
    await collect(
      streamOpenAI(
        { ...req, tools: undefined },
        {
          model: "m",
          baseURL: "https://x",
          fetch: fetchFn,
          signal: new AbortController().signal,
          providerId: "openai",
        },
      ),
    );
    expect(body.messages.some((m: any) => m.role === "tool")).toBe(false);
    expect(JSON.stringify(body.messages)).toContain("[tool read result]");
  });
});

describe("anthropic adapter", () => {
  test("cache_control on system/tools/tail, streams tool_use json deltas", async () => {
    let body: any;
    const fetchFn = async (_u: any, init?: RequestInit) => {
      body = JSON.parse(String(init!.body));
      return sse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 50, cache_read_input_tokens: 1000, output_tokens: 1 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Let me look." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"filePath":"b' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '.ts"}' },
        },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
        { type: "message_stop" },
      ]);
    };
    const out = await collect(
      streamAnthropic(req, {
        model: "claude",
        key: "k",
        baseURL: "https://a/v1",
        fetch: fetchFn,
        signal: new AbortController().signal,
      }),
    );
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[2].content[0].type).toBe("tool_result");
    expect(out.find((c) => c.type === "tool-call")).toEqual({
      type: "tool-call",
      callId: "toolu_1",
      name: "read",
      input: { filePath: "b.ts" },
    });
    expect((out.at(-1) as any).usage).toEqual({
      input: 50,
      output: 30,
      reasoning: 0,
      cacheRead: 1000,
      cacheWrite: 0,
    });
  });
});

// --- AWS event-stream encoder (test helper) ---
function frame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const enc = new TextEncoder();
  const hparts: number[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const kb = enc.encode(k);
    const vb = enc.encode(v);
    hparts.push(kb.length, ...kb, 7, (vb.length >> 8) & 0xff, vb.length & 0xff, ...vb);
  }
  const pb = enc.encode(JSON.stringify(payload));
  const total = 12 + hparts.length + pb.length + 4;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, total);
  dv.setUint32(4, hparts.length);
  buf.set(hparts, 12);
  buf.set(pb, 12 + hparts.length);
  return buf;
}
const ev = (type: string, payload: unknown) =>
  frame(
    { ":event-type": type, ":message-type": "event", ":content-type": "application/json" },
    payload,
  );

describe("bedrock adapter", () => {
  test("decodes event-stream frames split across chunks", async () => {
    const frames = [
      ev("messageStart", { role: "assistant" }),
      ev("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hi" } }),
      ev("contentBlockStart", {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: "tu1", name: "read" } },
      }),
      ev("contentBlockDelta", {
        contentBlockIndex: 1,
        delta: { toolUse: { input: '{"filePath":"c.ts"}' } },
      }),
      ev("messageStop", { stopReason: "tool_use" }),
      ev("metadata", { usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3 } }),
    ];
    const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of frames) {
      all.set(f, o);
      o += f.length;
    }
    let url = "";
    let headers: any;
    const fetchFn = async (u: any, init?: RequestInit) => {
      url = String(u);
      headers = init!.headers;
      const body = new ReadableStream({
        start(c) {
          for (let i = 0; i < all.length; i += 7) c.enqueue(all.slice(i, i + 7));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    };
    const out = await collect(
      streamBedrock(req, {
        model: "anthropic.claude-haiku:0",
        region: "eu-west-1",
        key: "bedrock-key",
        fetch: fetchFn,
        signal: new AbortController().signal,
      }),
    );
    expect(url).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-haiku%3A0/converse-stream",
    );
    expect(headers.Authorization).toBe("Bearer bedrock-key");
    expect(out.filter((c) => c.type === "text-delta").length).toBe(1);
    expect(out.find((c) => c.type === "tool-call")).toEqual({
      type: "tool-call",
      callId: "tu1",
      name: "read",
      input: { filePath: "c.ts" },
    });
    expect((out.at(-1) as any).usage.cacheRead).toBe(3);
  });

  test("exceptions map to retryable errors", async () => {
    const f = frame(
      { ":message-type": "exception", ":exception-type": "throttlingException" },
      { message: "slow down" },
    );
    const fetchFn = async () => new Response(f as Uint8Array<ArrayBuffer>, { status: 200 });
    const out = await collect(
      streamBedrock(req, {
        model: "m",
        region: "us-east-1",
        key: "k",
        fetch: fetchFn,
        signal: new AbortController().signal,
      }),
    );
    expect(out.at(-1)).toMatchObject({ type: "error", status: 429, retryable: true });
  });

  test("converse body: toolConfig, cachePoint only for supported models", () => {
    const claude = toConverse(req, "eu.anthropic.claude-haiku-4-5") as any;
    expect(claude.system.at(-1)).toEqual({ cachePoint: { type: "default" } });
    expect(claude.toolConfig.tools[0].toolSpec.name).toBe("read");
    expect(claude.messages[2].content[0].toolResult.status).toBe("success");
    const llama = toConverse(req, "meta.llama3") as any;
    expect(llama.system.length).toBe(1);
  });

  test("SigV4 matches the AWS get-vanilla test vector", () => {
    const h = signV4({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      body: "",
      region: "us-east-1",
      service: "service",
      creds: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      now: new Date("2015-08-30T12:36:00Z"),
      contentSha256Header: false,
    });
    expect(h.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  test("decoder rejects corrupt frames", () => {
    const d = new EventStreamDecoder();
    const bad = new Uint8Array(12);
    new DataView(bad.buffer).setUint32(0, 3);
    expect(() => d.push(bad)).toThrow("corrupt");
  });
});

describe("exa orchestrator", () => {
  const backends: Backend[] = [
    {
      id: "a",
      provider: "openrouter",
      model: "a",
      tier: "balanced",
      supportsTools: true,
      contextWindow: 100_000,
      priority: 1,
    },
    {
      id: "b",
      provider: "groq",
      model: "b",
      tier: "balanced",
      supportsTools: true,
      contextWindow: 100_000,
      priority: 2,
    },
    {
      id: "c",
      provider: "openai",
      model: "c",
      tier: "balanced",
      supportsTools: false,
      contextWindow: 100_000,
      priority: 0,
    },
    {
      id: "nokey",
      provider: "xai",
      model: "d",
      tier: "balanced",
      supportsTools: true,
      contextWindow: 100_000,
      priority: 0,
    },
  ];
  const cred = (p: string) => (p === "xai" ? null : { key: "k", source: "pool" as const });

  test("classify picks tiers from cheap signals", () => {
    const m = (t: string, tools = false): ModelRequest => ({
      model: "exa",
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: t }] }],
      tools: tools ? req.tools : undefined,
    });
    expect(classify(m("hi there"))).toBe("fast");
    expect(classify(m("add a flag to the cli", true))).toBe("balanced");
    expect(classify(m("debug this race condition in the scheduler", true))).toBe("strong");
    expect(classify(m("hi"), "strong")).toBe("strong");
  });

  test("backends failing the same way are reported once", async () => {
    const fetchFn = async () =>
      new Response('{"error":{"message":"out of credits"}}', { status: 402 });
    // the dev setup: several backends on one OpenRouter key
    const sameKey = backends.slice(0, 2).map((b) => ({ ...b, provider: "openrouter" }));
    const r = new ExaRouter({ backends: sameKey, credential: cred, fetch: fetchFn });
    const run = collect(r.stream(req, new AbortController().signal, "balanced"));
    const err = await run.catch((e: Error) => e);
    expect((err as Error).message).toBe(
      'exa: no model for tier "balanced" could answer: openrouter 402: out of credits',
    );
  });

  test("filters by tool support + credentials, falls back on failure, opens circuit", async () => {
    let calls: string[] = [];
    const fetchFn = async (_u: any, init?: RequestInit) => {
      const model = JSON.parse(String(init!.body)).model;
      calls.push(model);
      if (model === "a") return new Response("boom", { status: 500 });
      return sse([
        { choices: [{ delta: { content: `from ${model}` }, finish_reason: "stop" }] },
        "[DONE]",
      ]);
    };
    let t = 0;
    const r = new ExaRouter({ backends, credential: cred, fetch: fetchFn, now: () => t });
    expect(r.candidates(req, "balanced").map((b) => b.id)).toEqual(["a", "b"]);
    for (let i = 0; i < 3; i++) {
      const out = await collect(r.stream(req, new AbortController().signal, "balanced"));
      expect(out.find((c) => c.type === "text-delta")).toEqual({
        type: "text-delta",
        text: "from b",
      });
    }
    expect(calls).toEqual(["a", "b", "a", "b", "a", "b"]);
    // circuit for "a" is now open → b first
    calls = [];
    await collect(r.stream(req, new AbortController().signal, "balanced"));
    expect(calls).toEqual(["b"]);
    t += 31_000; // cooldown elapsed → a is tried again
    calls = [];
    await collect(r.stream(req, new AbortController().signal, "balanced"));
    expect(calls[0]).toBe("a");
  });

  test("no candidates → clear 503", async () => {
    const r = new ExaRouter({ backends, credential: () => null });
    await expect(collect(r.stream(req, new AbortController().signal))).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("vault", () => {
  const vault = new KeyVault({ 1: crypto.getRandomValues(new Uint8Array(32)) });
  test("roundtrip, tenant binding, rotation", async () => {
    const sealed = await vault.encrypt("tenant-a", "sk-live-1234567890");
    expect(sealed.last4).toBe("7890");
    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain("sk-live");
    expect(await vault.decrypt("tenant-a", sealed)).toBe("sk-live-1234567890");
    await expect(vault.decrypt("tenant-b", sealed)).rejects.toThrow();
    const k1 = crypto.getRandomValues(new Uint8Array(32));
    const v1 = new KeyVault({ 1: k1 });
    const s1 = await v1.encrypt("t", "secret");
    const v2 = new KeyVault({ 1: k1, 2: crypto.getRandomValues(new Uint8Array(32)) });
    const rotated = await v2.rewrap("t", s1);
    expect(rotated.keyVersion).toBe(2);
    expect(await v2.decrypt("t", rotated)).toBe("secret");
  });
});

describe("gateway", () => {
  const usage: UsageRecord[] = [];
  const ports = (over: Partial<GatewayPorts> = {}): GatewayPorts => ({
    byok: async (_p, provider) =>
      provider === "openai" ? { key: "user-key", source: "byok_user" } : null,
    policy: async () => ({
      byokEnabled: true,
      poolForDirect: false,
      allowed: ["exa*", "openai/*", "anthropic/*"],
    }),
    checkQuota: async () => {},
    recordUsage: (u) => usage.push(u),
    ...over,
  });
  const okFetch = async () =>
    sse([
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } },
      "[DONE]",
    ]);
  const principal = { tenantId: "t", userId: "u" };

  test("BYOK key used for direct models; usage + cost recorded", async () => {
    let auth = "";
    const g = new Gateway({
      ports: ports(),
      fetch: async (_u, init) => ((auth = (init!.headers as any).Authorization), okFetch()),
    });
    const out = await collect(
      g.stream(principal, { ...req, model: "openai/gpt-5-mini" }, new AbortController().signal),
    );
    expect(auth).toBe("Bearer user-key");
    expect(out.at(-1)!.type).toBe("finish");
    const u = usage.at(-1)!;
    expect(u.keySource).toBe("byok_user");
    expect(u.modelUsed).toBe("openai/gpt-5-mini");
    expect(u.costUsd).toBeCloseTo(costFor("openai/gpt-5-mini", { input: 1000, output: 100 }));
  });

  test("policy, missing key and quota errors", async () => {
    const g = new Gateway({ ports: ports(), fetch: okFetch as any });
    await expect(
      collect(g.stream(principal, { ...req, model: "xai/grok-4" }, new AbortController().signal)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      collect(
        g.stream(principal, { ...req, model: "anthropic/claude-x" }, new AbortController().signal),
      ),
    ).rejects.toMatchObject({ status: 401 });
    const q = new Gateway({
      ports: ports({
        checkQuota: async () => {
          throw Object.assign(new Error("over quota"), { status: 429 });
        },
      }),
    });
    await expect(
      collect(q.stream(principal, { ...req, model: "exa" }, new AbortController().signal)),
    ).rejects.toThrow("over quota");
  });

  test("exa uses the platform pool", async () => {
    const g = new Gateway({
      ports: ports(),
      pool: { GROQ_API_KEY: "pool-groq" },
      backends: [
        {
          id: "g",
          provider: "groq",
          model: "llama",
          tier: "fast",
          supportsTools: true,
          contextWindow: 100_000,
          priority: 1,
        },
      ],
      fetch: okFetch as any,
    });
    const out = await collect(
      g.stream(principal, { ...req, model: "exa/fast" }, new AbortController().signal),
    );
    expect(out.find((c) => c.type === "start")).toMatchObject({ provider: "groq", model: "llama" });
    expect(usage.at(-1)!.modelUsed).toBe("groq/llama");
  });
});
