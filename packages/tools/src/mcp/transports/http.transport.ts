// MCP over streamable HTTP: each JSON-RPC message is a POST; the reply is either plain JSON
// or an SSE stream. The server's `mcp-session-id` is echoed on later requests.

import { readSse } from "@exa/protocol";
import type { McpServerConfig } from "../mcp.config.ts";
import {
  type JsonRpcMessage,
  MCP_PROTOCOL_VERSION,
  rpcError,
  Transport,
} from "./base.transport.ts";

// ---------- constants ----------
const SESSION_HEADER = "mcp-session-id";
const ERROR_BODY_PREVIEW_CHARS = 300;

// ---------- types ----------
type RemoteConfig = Extract<McpServerConfig, { type: "remote" }>;

// ---------- http transport ----------
export class HttpTransport extends Transport {
  private id = 0;
  private sessionId: string | null = null;

  constructor(
    private readonly cfg: RemoteConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    super();
  }

  async send(
    msg: Record<string, unknown>,
    expectResponse: boolean,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = expectResponse ? ++this.id : undefined;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await this.post(msg, id, ac.signal);
      if (!expectResponse) return undefined;
      return await readResult(res, id, ac.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await this.fetchFn(this.cfg.url, {
      method: "DELETE",
      headers: { [SESSION_HEADER]: this.sessionId, ...this.cfg.headers },
    }).catch(() => {}); // best effort: the server may already have dropped the session
  }

  /** POST one message, remember the session id, and throw on HTTP errors. */
  private async post(
    msg: Record<string, unknown>,
    id: number | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const res = await this.fetchFn(this.cfg.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), ...msg }),
      signal,
    });
    const sid = res.headers.get(SESSION_HEADER);
    if (sid) this.sessionId = sid;
    if (!res.ok)
      throw new Error(
        `MCP HTTP ${res.status}: ${(await res.text()).slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
      );
    return res;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      ...(this.sessionId ? { [SESSION_HEADER]: this.sessionId } : {}),
      ...this.cfg.headers,
    };
  }
}

// ---------- helpers ----------
/** The result for request `id`, from either an SSE stream or a JSON body. */
async function readResult(
  res: Response,
  id: number | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    for await (const f of readSse(res.body!, signal)) {
      if (!f.data) continue;
      const r = pickResult(JSON.parse(f.data), id);
      if (r !== undefined) return r;
    }
    throw new Error("MCP stream ended without a response");
  }
  const r = pickResult(await res.json(), id);
  if (r === undefined) throw new Error("MCP response id mismatch");
  return r;
}

/** The message's result if it answers `id` (throwing its error, if any); else undefined. */
function pickResult(m: JsonRpcMessage | null | undefined, id: number | undefined): unknown {
  if (!m || m.id !== id) return undefined;
  if (m.error) throw rpcError(m.error);
  return m.result;
}
