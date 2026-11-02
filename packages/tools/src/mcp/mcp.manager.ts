// MCP (Model Context Protocol) manager: connects every configured server — stdio (local
// process) or streamable HTTP (remote) — and exposes their tools as exa tools. Server
// `instructions` are added to the system prompt (it is an InstructionsPort).

import type { InstructionsPort, ToolSpec } from "@exa/core";
import { McpClient } from "./mcp.client.ts";
import type { McpServerConfig } from "./mcp.config.ts";
import { mcpToolSpecs, safeMcpName } from "./mcp-tools.ts";

// ---------- mcp manager ----------
export class McpManager implements InstructionsPort {
  readonly clients: McpClient[] = [];
  readonly errors: Array<{ name: string; error: string }> = [];

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly root: string,
    private readonly fetchFn?: typeof fetch,
  ) {}

  /** Connect all enabled servers in parallel; failures are reported, never fatal. */
  async start(): Promise<ToolSpec[]> {
    const entries = Object.entries(this.servers).filter(([, c]) => c.enabled !== false);
    const results = await Promise.allSettled(entries.map(([name, cfg]) => this.connect(name, cfg)));
    const specs: ToolSpec[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        this.clients.push(r.value);
        specs.push(...mcpToolSpecs(r.value));
      } else this.errors.push({ name: entries[i][0], error: (r.reason as Error).message });
    });
    return specs;
  }

  async load(): Promise<Array<{ source: string; content: string }>> {
    return this.clients
      .filter((c) => c.instructions)
      .map((c) => ({ source: `MCP server "${c.name}"`, content: c.instructions }));
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()));
  }

  private async connect(name: string, cfg: McpServerConfig): Promise<McpClient> {
    const client = new McpClient(safeMcpName(name), cfg, this.root, this.fetchFn);
    await client.connect();
    return client;
  }
}
