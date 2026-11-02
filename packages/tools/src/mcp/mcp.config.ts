// MCP server configuration: the normalized config shape and a parser that accepts the
// common config-file dialects (OpenCode `mcp`, Claude-style `mcpServers`, legacy `servers`).

// ---------- types ----------
export type McpServerConfig =
  | {
      type: "local";
      command: string[];
      environment?: Record<string, string>;
      cwd?: string;
      enabled?: boolean;
      timeout?: number;
    }
  | {
      type: "remote";
      url: string;
      headers?: Record<string, string>;
      enabled?: boolean;
      timeout?: number;
    };

/** One server entry as written in a config file (any dialect). */
interface RawServerEntry {
  url?: string;
  headers?: Record<string, string>;
  command?: unknown;
  args?: string[];
  env?: Record<string, string>;
  environment?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  timeout?: number;
}

// ---------- parse ----------
/** Accepts OpenCode-style {"mcp": {...}} and legacy {"servers": [{name, cmd}]} config files. */
// biome-ignore lint/suspicious/noExplicitAny: raw, untrusted config JSON
export function parseMcpConfig(json: any): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  const src = json?.mcp ?? json?.mcpServers ?? null;
  if (src && typeof src === "object") {
    for (const [name, v] of Object.entries<RawServerEntry | undefined>(src)) {
      const cfg = parseServerEntry(v);
      if (cfg) out[name] = cfg;
    }
  }
  for (const s of json?.servers ?? []) {
    if (s?.name && typeof s.cmd === "string")
      out[s.name] = { type: "local", command: s.cmd.split(/\s+/) };
  }
  return out;
}

// ---------- helpers ----------
function parseServerEntry(v: RawServerEntry | undefined): McpServerConfig | undefined {
  if (v?.url) return remoteServer(v as RawServerEntry & { url: string });
  if (Array.isArray(v?.command)) return localServerFromArray(v as RawServerEntry);
  if (typeof v?.command === "string") return localServerFromString(v as RawServerEntry);
  return undefined;
}

function remoteServer(v: RawServerEntry & { url: string }): McpServerConfig {
  return {
    type: "remote",
    url: v.url,
    headers: v.headers,
    enabled: v.enabled,
    timeout: v.timeout,
  };
}

/** OpenCode style: `command: ["bin", ...args]`, `environment` preferred over `env`. */
function localServerFromArray(v: RawServerEntry): McpServerConfig {
  return {
    type: "local",
    command: v.command as string[],
    environment: v.environment ?? v.env,
    cwd: v.cwd,
    enabled: v.enabled,
    timeout: v.timeout,
  };
}

/** Claude style: `command: "bin"`, `args: [...]`, `env` preferred over `environment`. */
function localServerFromString(v: RawServerEntry): McpServerConfig {
  return {
    type: "local",
    command: [v.command as string, ...(v.args ?? [])],
    environment: v.env ?? v.environment,
    cwd: v.cwd,
    enabled: v.enabled,
    timeout: v.timeout,
  };
}
