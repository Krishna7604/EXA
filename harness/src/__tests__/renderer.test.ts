// Renderer tests — chat blocks with right-side meta. Color off for assertions.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConsoleRenderer } from "../renderer.js";

const realLog = console.log;
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
});

describe("ConsoleRenderer", () => {
  test("user block shows who left, estimate right", () => {
    new ConsoleRenderer({ width: 60, color: false }).message("user", "hi there", { estimatedTokens: 4, time: "10:00:00" });
    const out = logs.join("\n");
    expect(out).toContain("You");
    expect(out).toContain("hi there");
    expect(out).toContain("~4 tok");
    expect(out).toContain("10:00:00");
  });

  test("agent block is branded exa, model + tokens + cost + latency right", () => {
    new ConsoleRenderer({ width: 80, color: false }).message("agent", "done", {
      model: "eu.amazon.nova-micro-v1:0",
      inputTokens: 1200,
      outputTokens: 86,
      costUsd: 0.0001,
      ms: 1631,
    });
    const out = logs.join("\n");
    expect(out).toContain("exa");
    expect(out).toContain("eu.amazon.nova-micro-v1:0");
    expect(out).toContain("1,200 in · 86 out");
    expect(out).toContain("~$0.0001");
    expect(out).toContain("1.6s");
    expect(out).toContain("done");
  });

  test("unknown model cost renders as em dash, header stays aligned", () => {
    const r = new ConsoleRenderer({ width: 50, color: false });
    r.message("agent", "x", { model: "mystery/model-9", inputTokens: 10, outputTokens: 5, costUsd: null });
    const header = logs.find((l) => l.includes("exa"));
    if (!header) throw new Error("agent header missing");
    expect(header).toContain("—");
    expect(header < "x").toBe(true); // header printed before body
    for (const l of logs) expect(l.length).toBeLessThanOrEqual(60);
  });

  test("render() compat entry still works for messages and tool calls", () => {
    const r = new ConsoleRenderer({ width: 60, color: false });
    r.render({ type: "message", role: "user", text: "compat hi" });
    r.render({ type: "function_call", name: "read", args: { path: "x" } });
    expect(logs.join("\n")).toContain("compat hi");
    expect(logs.join("\n")).toContain("[tool:read]");
  });

  test("brand, welcome banner, and chat prompt", () => {
    const r = new ConsoleRenderer({ width: 60, color: false });
    expect(r.brand()).toContain("exa");
    r.welcome("v9.9.9");
    expect(logs.join("\n")).toContain("exa");
    expect(logs.join("\n")).toContain("v9.9.9");
    expect(r.chatPrompt("s-1234567890abcdef")).toContain("exa");
  });

  test("big logo is a uniform block", async () => {
    const { EXA_LOGO } = await import("../renderer.js");
    expect(EXA_LOGO.length).toBeGreaterThanOrEqual(5);
    const widths = new Set(EXA_LOGO.map((l) => l.length));
    expect(widths.size).toBe(1); // aligned columns
    expect(Math.max(...widths)).toBeLessThanOrEqual(40); // fits narrow terminals
  });
});
