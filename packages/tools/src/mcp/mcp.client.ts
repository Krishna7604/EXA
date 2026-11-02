// One connected MCP server: performs the initialize handshake, lists its tools, and calls
// them, flattening tool results to text.

import type { McpServerConfig } from "./mcp.config.ts";
import { MCP_PROTOCOL_VERSION, type Transport } from "./transports/base.transport.ts";
import { HttpTransport } from "./transports/http.transport.ts";
import { StdioTransport } from "./transports/stdio.transport.ts";

// ---------- constants ----------
const CLIENT_INFO = { name: "exa", version: "2.0.0" };
const DEFAULT_TIMEOUT_MS = 30_000;
/** Servers that spawn slowly still get at least this long to finish initialize. */
const MIN_INIT_TIMEOUT_MS = 15_000;
/** Upper bound on tools/list pagination, in case a server keeps returning cursors. */
const MAX_TOOL_PAGES = 20;

// ---------- types ----------
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

interface InitializeResult {
  instructions?: unknown;
}

interface ToolsListResult {
  tools?: McpToolInfo[];
  nextCursor?: string;
}

interface ToolContent {
  type: string;
  text?: string;
  mimeType?: string;
  resource?: { text?: string };
}

interface ToolCallResult {
  content?: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

// ---------- mcp client ----------
export class McpClient {
  instructions = "";
  tools: McpToolInfo[] = [];
  private transport!: Transport;

  constructor(
    readonly name: string,
    private readonly cfg: McpServerConfig,
    private readonly root: string,
    private readonly fetchFn?: typeof fetch,
  ) {}

  get timeout(): number {
    return this.cfg.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    this.transport = this.openTransport();
    await this.initialize();
    this.tools = await this.listTools();
  }

  async call(
    tool: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    const request = this.transport.send(
      { method: "tools/call", params: { name: tool, arguments: args ?? {} } },
      true,
      this.timeout,
    );
    const aborted = new Promise<never>((_, rej) =>
      signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }),
    );
    const r = (await Promise.race([request, aborted])) as ToolCallResult | undefined;
    return { text: resultText(r), isError: !!r?.isError };
  }

  close(): Promise<void> {
    return this.transport?.close() ?? Promise.resolve();
  }

  private openTransport(): Transport {
    if (this.cfg.type === "local") return new StdioTransport(this.cfg, this.root);
    return new HttpTransport(this.cfg, this.fetchFn);
  }

  private async initialize(): Promise<void> {
    const init = (await this.transport.send(
      {
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      },
      true,
      Math.max(this.timeout, MIN_INIT_TIMEOUT_MS),
    )) as InitializeResult | undefined;
    this.instructions = typeof init?.instructions === "string" ? init.instructions : "";
    await this.transport.send({ method: "notifications/initialized" }, false, this.timeout);
  }

  private async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const r = (await this.transport.send(
        { method: "tools/list", params: cursor ? { cursor } : {} },
        true,
        this.timeout,
      )) as ToolsListResult | undefined;
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }
}

// ---------- helpers ----------
/** Flatten a tools/call result to text; structured content is the fallback when there's none. */
function resultText(r: ToolCallResult | undefined): string {
  const parts = (r?.content ?? []).map(contentText);
  if (!parts.length && r?.structuredContent)
    parts.push(JSON.stringify(r.structuredContent, null, 2));
  return parts.join("\n");
}

function contentText(c: ToolContent): string {
  if (c.type === "text") return c.text as string;
  if (c.type === "resource" && c.resource?.text) return c.resource.text;
  if (c.type === "image") return `[image ${c.mimeType ?? ""} omitted]`;
  return JSON.stringify(c);
}
