// MCP server config for the heavy client, merged from ~/.exa/mcp.json, opencode.json ("mcp")
// and .exa/mcp.json (later files win on name clashes).

import { join } from "node:path";
import { type McpServerConfig, parseMcpConfig } from "@exa/tools";
import { EXA_HOME } from "./exa-home.config.ts";

// ---------- config ----------
export async function loadMcpServers(root: string): Promise<Record<string, McpServerConfig>> {
  const servers: Record<string, McpServerConfig> = {};
  for (const f of configFiles(root)) {
    try {
      Object.assign(servers, parseMcpConfig(JSON.parse(await Bun.file(f).text())));
    } catch {
      // missing or unreadable config files are simply skipped
    }
  }
  return servers;
}

// ---------- helpers ----------
function configFiles(root: string): string[] {
  return [join(EXA_HOME, "mcp.json"), join(root, "opencode.json"), join(root, ".exa", "mcp.json")];
}
