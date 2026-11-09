// Connects one remote MCP server (streamable HTTP) for the server-side agent: a deadline so a
// hung server can't stall a chat, redirects refused (secret headers must never follow one),
// and tools whose names would shadow a built-in tool dropped. Combines several into one set.
import type { ToolSpec } from "@exa/core";
import { builtinTools, McpManager } from "@exa/tools";
import type { ConnectedTools } from "../models/connector.model.ts";

// ---------- constants ----------
const MS_PER_SECOND = 1000;
/** McpManager only uses its root for local (stdio) servers; remote ones never touch disk. */
const NO_LOCAL_ROOT = "/";
const REDIRECT_MIN_STATUS = 300;
const REDIRECT_MAX_STATUS = 399;
/** Tools the loop registers itself, on top of the built-in set. */
const LOOP_TOOL_NAMES = ["task", "tool_search"];
/** Every tool name the agent may already have; a connector tool may not replace one. */
const RESERVED_TOOL_NAMES = new Set([
  ...builtinTools({ shell: true, web: true, search: true, memory: true, question: true }).map(
    (t) => t.name,
  ),
  ...LOOP_TOOL_NAMES,
]);

// ---------- types ----------
export interface McpTarget {
  name: string;
  url: string;
  headers: Record<string, string>;
}

/** One server's outcome: a live manager and its tools, or why it isn't available. */
export interface McpConnection {
  name: string;
  manager: McpManager | null;
  tools: ToolSpec[];
  error?: string;
}

export interface McpConnectOptions {
  timeoutMs: number;
  fetch?: typeof fetch;
}

// ---------- connect ----------
/** Never throws: a failure or a missed deadline comes back as `error`. */
export async function connectMcpServer(
  target: McpTarget,
  opts: McpConnectOptions,
): Promise<McpConnection> {
  const config = { type: "remote" as const, url: target.url, headers: target.headers };
  const fetchFn = refuseRedirects(opts.fetch ?? fetch);
  const manager = new McpManager({ [target.name]: config }, NO_LOCAL_ROOT, fetchFn);
  const started = manager.start();
  const tools = await withDeadline(started, opts.timeoutMs);
  if (!tools) {
    closeWhenSettled(started, manager);
    const seconds = opts.timeoutMs / MS_PER_SECOND;
    return { name: target.name, manager: null, tools: [], error: `no answer within ${seconds} s` };
  }
  const failure = manager.errors[0]?.error;
  if (failure) return { name: target.name, manager: null, tools: [], error: failure };
  const allowed = tools.filter((t) => !RESERVED_TOOL_NAMES.has(t.name));
  return { name: target.name, manager, tools: allowed };
}

/** The live connections as one tool set, one instructions source and one `close`. */
export function combineMcpConnections(connections: McpConnection[]): ConnectedTools {
  const managers = connections.flatMap((c) => (c.manager ? [c.manager] : []));
  return {
    tools: connections.flatMap((c) => c.tools),
    instructions: {
      load: async () => (await Promise.all(managers.map((m) => m.load()))).flat(),
    },
    close: async () => {
      await Promise.all(managers.map((m) => m.close()));
    },
  };
}

// ---------- helpers ----------
function refuseRedirects(fetchFn: typeof fetch): typeof fetch {
  const guarded = async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetchFn(input, { ...init, redirect: "manual" });
    const isRedirect = res.status >= REDIRECT_MIN_STATUS && res.status <= REDIRECT_MAX_STATUS;
    if (isRedirect)
      throw new Error(`the server redirected (HTTP ${res.status}); configure its final URL`);
    return res;
  };
  return guarded as typeof fetch;
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A connect that lands after its deadline still opened an MCP session: end it. */
function closeWhenSettled(started: Promise<unknown>, manager: McpManager): void {
  started
    .then(() => manager.close())
    .catch((err) => console.error("[exa-server] closing a late MCP connection failed", err));
}
