import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExaEvent,
  type ModelChunk,
  newId,
  type PermissionReply,
  type PermissionRequest,
  type SessionInfo,
  zeroTokens,
} from "@exa/protocol";
import { z } from "zod";
import {
  AgentLoop,
  AgentRegistry,
  builtinRules,
  defineTool,
  EventBus,
  MemoryStore,
  type Script,
  ScriptedModel,
  ToolRegistry,
  text,
  toolCall,
} from "../index.ts";

const calls: string[] = [];
const echo = defineTool({
  name: "echo",
  description: "echo",
  schema: z.object({ msg: z.string() }),
  readonly: true,
  permissions: () => [],
  async execute(i) {
    calls.push(i.msg);
    await Bun.sleep(20);
    return { output: `echo:${i.msg}`, title: i.msg };
  },
});
const danger = defineTool({
  name: "danger",
  description: "needs approval",
  schema: z.object({ x: z.string() }),
  readonly: false,
  permissions: (i) => [{ permission: "danger", patterns: [i.x] }],
  async execute(i) {
    return { output: `did ${i.x}`, title: i.x };
  },
});

function setup(
  scripts: Script[],
  opts: { replies?: PermissionReply[]; rules?: any[]; config?: any; mode?: any } = {},
) {
  const store = new MemoryStore();
  const bus = new EventBus();
  const events: ExaEvent[] = [];
  bus.subscribeAll((e) => events.push(e));
  const asked: PermissionRequest[] = [];
  const replies = [...(opts.replies ?? [])];
  const model = new ScriptedModel(scripts);
  const loop = new AgentLoop({
    model,
    store,
    events: bus,
    tools: new ToolRegistry([echo, danger]),
    agents: new AgentRegistry(),
    permissions: {
      rules: () => [...builtinRules(), ...(opts.rules ?? [])],
      mode: () => opts.mode ?? "default",
      approvals: {
        async request(r) {
          asked.push(r);
          return replies.shift() ?? "reject";
        },
      },
    },
    env: () => ({
      root: "/repo",
      cwd: "/repo",
      platform: "test",
      date: "2026-10-10",
      isGitRepo: false,
      host: "client",
    }),
    outputDir: join(tmpdir(), "exa-test-out"),
    config: { autoTitle: false, retryBaseMs: 1, ...opts.config },
  });
  const session: SessionInfo = {
    id: newId(),
    tenantId: "t",
    userId: "u",
    projectId: null,
    parentId: null,
    title: null,
    directory: "/repo",
    agent: "build",
    model: "exa",
    loopHost: "client",
    storageMode: "none",
    status: "active",
    revert: null,
    tokens: zeroTokens(),
    cost: 0,
    time: { created: Date.now(), updated: Date.now() },
  };
  return {
    store,
    bus,
    events,
    asked,
    model,
    loop,
    session,
    init: () => store.createSession(session),
  };
}

describe("AgentLoop", () => {
  test("text-only reply persists user + assistant with step bracket", async () => {
    const t = setup([text("hello there")]);
    await t.init();
    const r = await t.loop.prompt({ sessionId: t.session.id, text: "hi" });
    expect(r.text).toBe("hello there");
    expect(r.finish).toBe("stop");
    const msgs = await t.store.messages(t.session.id);
    expect(msgs.map((m) => m.info.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].parts.map((p) => p.type)).toEqual(["step-start", "text", "step-finish"]);
    expect(t.events.some((e) => e.type === "message.part.delta")).toBe(true);
    expect(t.events.at(-1)!.type).toBe("session.idle");
    const s = await t.store.getSession(t.session.id);
    expect(s!.tokens.input).toBe(100);
  });

  test("tool loop: call → result fed back → final answer; parallel readonly calls", async () => {
    calls.length = 0;
    const t = setup([
      [
        { type: "tool-call", callId: "a", name: "echo", input: { msg: "one" } },
        { type: "tool-call", callId: "b", name: "echo", input: { msg: "two" } },
        { type: "finish", reason: "tool-calls", usage: { input: 50, output: 5 } },
      ],
      text("done"),
    ]);
    await t.init();
    const started = Date.now();
    const r = await t.loop.prompt({ sessionId: t.session.id, text: "go" });
    expect(Date.now() - started).toBeLessThan(150);
    expect(r.text).toBe("done");
    expect(calls.sort()).toEqual(["one", "two"]);
    const second = t.model.requests[1];
    const results = second.messages.at(-1)!.content.filter((b) => b.type === "tool-result");
    expect(results.length).toBe(2);
    expect(second.messages.at(-2)!.role).toBe("assistant");
  });

  test("ask → approval once runs the tool; reject stops the loop", async () => {
    const ok = setup([toolCall("danger", { x: "a" }), text("after")], { replies: ["once"] });
    await ok.init();
    const r1 = await ok.loop.prompt({ sessionId: ok.session.id, text: "go" });
    expect(r1.text).toBe("after");
    expect(ok.asked.length).toBe(1);

    const no = setup([toolCall("danger", { x: "a" }), text("never")], { replies: ["reject"] });
    await no.init();
    const r2 = await no.loop.prompt({ sessionId: no.session.id, text: "go" });
    expect(no.model.requests.length).toBe(1);
    const msgs = await no.store.messages(no.session.id);
    const tool = msgs[1].parts.find((p) => p.type === "tool");
    expect(tool && tool.type === "tool" && tool.state.status).toBe("error");
    expect(r2.text).toBe("");
  });

  test("fully denied tools are hidden from the model", async () => {
    const t = setup([text("ok")], {
      rules: [{ permission: "danger", pattern: "*", action: "deny", scope: "tenant" }],
    });
    await t.init();
    await t.loop.prompt({ sessionId: t.session.id, text: "go" });
    const names = t.model.requests[0].tools!.map((d) => d.name);
    expect(names).toContain("echo");
    expect(names).not.toContain("danger");
  });

  test("invalid args and unknown tools come back as errors the model can fix", async () => {
    const t = setup([toolCall("echo", { nope: 1 }), toolCall("missing", {}), text("ok")]);
    await t.init();
    await t.loop.prompt({ sessionId: t.session.id, text: "go" });
    const r1 = t.model.requests[1].messages.at(-1)!.content[0];
    expect(r1.type === "tool-result" && r1.isError && r1.output).toContain("Invalid arguments");
    const r2 = t.model.requests[2].messages.at(-1)!.content[0];
    expect(r2.type === "tool-result" && r2.output).toContain("Unknown or unavailable tool");
  });

  test("doom loop: third identical call asks; reject stops", async () => {
    const same = () => toolCall("echo", { msg: "same" });
    const t = setup([same(), same(), same(), text("never")], { replies: ["reject"] });
    await t.init();
    await t.loop.prompt({ sessionId: t.session.id, text: "go" });
    expect(t.asked.length).toBe(1);
    expect(t.asked[0].permission).toBe("doom_loop");
    expect(t.model.requests.length).toBe(3);
  });

  test("step cap: last step has no tools and a summarize instruction", async () => {
    const t = setup(
      [toolCall("echo", { msg: "1" }), toolCall("echo", { msg: "2" }), text("summary")],
      { config: { maxSteps: 2 } },
    );
    await t.init();
    const r = await t.loop.prompt({ sessionId: t.session.id, text: "go" });
    expect(t.model.requests.length).toBe(2);
    expect(t.model.requests[1].tools).toBeUndefined();
    const last = t.model.requests[1].messages.at(-1)!;
    expect(JSON.stringify(last)).toContain("maximum number of steps");
    expect(r.steps).toBe(2);
  });

  test("retries retryable errors before output, surfaces others", async () => {
    const t = setup([
      [{ type: "error", message: "overloaded", status: 529, retryable: true }],
      text("recovered"),
    ]);
    await t.init();
    const r = await t.loop.prompt({ sessionId: t.session.id, text: "go" });
    expect(r.text).toBe("recovered");

    const bad = setup([[{ type: "error", message: "bad request", status: 400, retryable: false }]]);
    await bad.init();
    const r2 = await bad.loop.prompt({ sessionId: bad.session.id, text: "go" });
    expect(r2.finish).toBe("error");
    expect(r2.error?.message).toContain("bad request");
    expect(bad.events.some((e) => e.type === "session.error")).toBe(true);
  });

  test("abort mid-stream ends with finish=aborted", async () => {
    const slow: Script = async () => {
      await Bun.sleep(50);
      return text("late");
    };
    const t = setup([slow]);
    await t.init();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const r = await t.loop.prompt({ sessionId: t.session.id, text: "go", signal: ac.signal });
    expect(r.finish).toBe("aborted");
  });

  test("busy session rejects a concurrent prompt", async () => {
    const t = setup([async () => (await Bun.sleep(30), text("a"))]);
    await t.init();
    const p = t.loop.prompt({ sessionId: t.session.id, text: "one" });
    await expect(t.loop.prompt({ sessionId: t.session.id, text: "two" })).rejects.toThrow("busy");
    await p;
  });

  test("auto-compaction summarizes older turns and keeps the latest user turn", async () => {
    const big = (t: string): ModelChunk[] => [
      { type: "text-delta", text: t },
      { type: "finish", reason: "stop", usage: { input: 900, output: 10 } },
    ];
    const t = setup(
      [
        big("first answer"),
        // turn 2 step 1 → triggers compaction before step 2? no: compaction happens at the next step
        [
          { type: "tool-call", callId: "c", name: "echo", input: { msg: "x" } },
          { type: "finish", reason: "tool-calls", usage: { input: 900, output: 5 } },
        ],
        text("SUMMARY: user asked things"),
        text("final"),
      ],
      { config: { contextLimit: 1000, compactThreshold: 0.8 } },
    );
    await t.init();
    await t.loop.prompt({ sessionId: t.session.id, text: "first question" });
    const r = await t.loop.prompt({ sessionId: t.session.id, text: "second question" });
    expect(r.text).toBe("final");
    const compactReq = t.model.requests[2];
    expect(compactReq.system).toContain("summarize");
    const finalReq = t.model.requests[3];
    const flat = JSON.stringify(finalReq.messages);
    expect(flat).toContain("SUMMARY: user asked things");
    expect(flat).toContain("second question");
    expect(flat).not.toContain("first question");
    expect(t.events.some((e) => e.type === "session.compacted")).toBe(true);
  });

  test("revert hides messages; next prompt deletes them", async () => {
    const t = setup([text("a1"), text("a2"), text("a3")]);
    await t.init();
    await t.loop.prompt({ sessionId: t.session.id, text: "q1" });
    await t.loop.prompt({ sessionId: t.session.id, text: "q2" });
    const msgs = await t.store.messages(t.session.id);
    const q2 = msgs.find(
      (m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "q2"),
    )!;
    await t.loop.revert(t.session.id, q2.info.id);
    await t.loop.prompt({ sessionId: t.session.id, text: "q3" });
    const flat = JSON.stringify(t.model.requests[2].messages);
    expect(flat).toContain("q1");
    expect(flat).not.toContain("q2");
    const after = await t.store.messages(t.session.id);
    expect(after.length).toBe(4);
  });

  test("task tool runs a subagent in a child session and returns its report", async () => {
    const t = setup([
      toolCall("task", { description: "look around", prompt: "find X", subagent_type: "explore" }),
      text("X is in a.ts"),
      text("parent done"),
    ]);
    await t.init();
    const r = await t.loop.prompt({ sessionId: t.session.id, text: "where is X" });
    expect(r.text).toBe("parent done");
    // subagent ran on the fast tier and could not see the task tool
    expect(t.model.requests[1].model).toBe("exa/fast");
    expect(t.model.requests[1].tools?.map((d) => d.name)).not.toContain("task");
    const res = t.model.requests[2].messages.at(-1)!.content[0];
    expect(res.type === "tool-result" && res.output).toContain("X is in a.ts");
    expect(t.events.filter((e) => e.type === "session.created").length).toBeGreaterThan(0);
  });

  test("plan mode denies edits (edit-keyed tools hidden)", async () => {
    const editLike = defineTool({
      name: "write",
      description: "w",
      schema: z.object({}),
      permissionKey: "edit",
      readonly: false,
      permissions: () => [{ permission: "edit", patterns: ["/repo/a"] }],
      async execute() {
        return { output: "", title: "" };
      },
    });
    const t = setup([text("plan")], { mode: "plan" });
    t.loop.deps.tools.register(editLike);
    await t.init();
    await t.loop.prompt({ sessionId: t.session.id, text: "go" });
    expect(t.model.requests[0].tools!.map((d) => d.name)).not.toContain("write");
  });

  test("deferred tools: names only until tool_search loads them", async () => {
    const t = setup(
      [
        toolCall("tool_search", { query: "select:ext_7" }),
        toolCall("ext_7", { v: 1 }),
        text("done"),
      ],
      { config: { deferThreshold: 5 } },
    );
    for (let i = 0; i < 12; i++) {
      t.loop.deps.tools.register({
        ...defineTool({
          name: `ext_${i}`,
          description: `external tool ${i}`,
          schema: z.object({ v: z.number() }),
          readonly: true,
          permissions: () => [],
          execute: async () => ({ output: `ext ${i} ran`, title: "" }),
        }),
        deferrable: true,
      });
    }
    await t.init();
    const r = await t.loop.prompt({ sessionId: t.session.id, text: "go" });
    expect(r.text).toBe("done");
    const names0 = t.model.requests[0].tools!.map((d) => d.name);
    expect(names0).toContain("tool_search");
    expect(names0.some((n) => n.startsWith("ext_"))).toBe(false);
    expect(t.model.requests[0].system).toContain("ext_7");
    const names1 = t.model.requests[1].tools!.map((d) => d.name);
    expect(names1).toContain("ext_7");
    expect(names1).not.toContain("ext_8");
    expect(JSON.stringify(t.model.requests[2].messages)).toContain("ext 7 ran");
  });

  test("a resumed session that is already over the window compacts before the first call", async () => {
    const t = setup([text("a1"), text("SUMMARY"), text("after")], {
      config: { contextLimit: 1000, compactThreshold: 0.8 },
    });
    await t.init();
    await t.loop.prompt({ sessionId: t.session.id, text: "x".repeat(5000) });
    await t.loop.prompt({ sessionId: t.session.id, text: "next" });
    expect(t.model.requests[1].system).toContain("summarize");
    expect(JSON.stringify(t.model.requests[2].messages)).not.toContain("x".repeat(100));
  });
});
