import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinRules, PermissionEngine, ToolRegistry } from "@exa/core";
import { parseMcpConfig } from "../mcp/mcp.config.ts";
import { McpManager } from "../mcp/mcp.manager.ts";

let dir: string;

// Minimal stdio MCP server (newline-delimited JSON-RPC) used as a fixture.
const SERVER = `
const tools = [
  { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a","b"] }, annotations: { readOnlyHint: true } },
  { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
];
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    if (m.method === "initialize") { console.log("noise on stdout is tolerated"); reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "calc" }, instructions: "Use calc tools for arithmetic." }); }
    else if (m.method === "tools/list") reply(m.params?.cursor ? { tools: [tools[1]] } : { tools: [tools[0]], nextCursor: "p2" });
    else if (m.method === "tools/call") {
      if (m.params.name === "add") reply({ content: [{ type: "text", text: String(m.params.arguments.a + m.params.arguments.b) }] });
      else reply({ content: [{ type: "text", text: "boom" }], isError: true });
    }
  }
});
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "exa-mcp-"));
  await writeFile(join(dir, "server.js"), SERVER);
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

describe("MCP", () => {
  test("stdio: handshake, paginated tools, calls, errors, instructions, permissions", async () => {
    const m = new McpManager(
      {
        calc: { type: "local", command: [process.execPath, join(dir, "server.js")] },
        dead: { type: "local", command: ["/no/such/bin"] },
      },
      dir,
    );
    const specs = await m.start();
    expect(specs.map((s) => s.name)).toEqual(["calc_add", "calc_fail"]);
    expect(m.errors.map((e) => e.name)).toEqual(["dead"]);
    expect(await m.load()).toEqual([
      { source: 'MCP server "calc"', content: "Use calc tools for arithmetic." },
    ]);
    const reg = new ToolRegistry(specs);
    expect(reg.definition("calc_add")!.parameters).toMatchObject({ required: ["a", "b"] });
    const ctx = { signal: new AbortController().signal } as any;
    expect((await specs[0].execute({ a: 2, b: 3 }, ctx)).output).toBe("5");
    await expect(specs[1].execute({}, ctx)).rejects.toThrow("boom");
    expect(specs[0].readonly).toBe(true);
    const asks = await specs[0].permissions({}, ctx);
    const engine = new PermissionEngine([
      ...builtinRules(),
      { permission: "mcp", pattern: "calc/*", action: "allow", scope: "user" },
    ]);
    expect(engine.evaluate(asks[0].permission, asks[0].patterns[0]).action).toBe("allow");
    expect(new PermissionEngine(builtinRules()).evaluate("mcp", "calc/add").action).toBe("ask");
    await m.close();
  });

  test("streamable HTTP: session header + SSE responses", async () => {
    let session = "";
    const fetchFn = (async (_u: any, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const msg = JSON.parse(String(init!.body));
      const hdrs = init!.headers as Record<string, string>;
      if (msg.method !== "initialize") expect(hdrs["mcp-session-id"]).toBe(session);
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result =
        msg.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {} }
          : msg.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    inputSchema: { type: "object", properties: { s: { type: "string" } } },
                  },
                ],
              }
            : { content: [{ type: "text", text: `echo:${msg.params.arguments.s}` }] };
      session = session || "sess-123";
      const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`;
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "mcp-session-id": session },
      });
    }) as unknown as typeof fetch;
    const m = new McpManager(
      { remote: { type: "remote", url: "https://mcp.example/mcp" } },
      dir,
      fetchFn,
    );
    const specs = await m.start();
    expect(specs[0].name).toBe("remote_echo");
    expect(
      (await specs[0].execute({ s: "hi" }, { signal: new AbortController().signal } as any)).output,
    ).toBe("echo:hi");
    await m.close();
  });

  test("config parsing: opencode, claude-style, and legacy formats", () => {
    expect(
      parseMcpConfig({
        mcp: { a: { type: "local", command: ["x", "y"] }, b: { type: "remote", url: "https://b" } },
      }),
    ).toEqual({
      a: {
        type: "local",
        command: ["x", "y"],
        environment: undefined,
        cwd: undefined,
        enabled: undefined,
        timeout: undefined,
      },
      b: {
        type: "remote",
        url: "https://b",
        headers: undefined,
        enabled: undefined,
        timeout: undefined,
      },
    });
    expect(
      parseMcpConfig({ mcpServers: { c: { command: "npx", args: ["-y", "srv"] } } }).c,
    ).toMatchObject({ type: "local", command: ["npx", "-y", "srv"] });
    expect(parseMcpConfig({ servers: [{ name: "rag", cmd: "uv run rag.py" }] }).rag).toEqual({
      type: "local",
      command: ["uv", "run", "rag.py"],
    });
  });
});
