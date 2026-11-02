// Turns a connected MCP server's tools into exa ToolSpecs named `<server>_<tool>`, gated by
// the `mcp` permission with pattern `<server>/<tool>`.

import type { ToolSpec } from "@exa/core";
import { z } from "zod";
import type { McpClient, McpToolInfo } from "./mcp.client.ts";

// ---------- constants ----------
const MAX_TOOL_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 2000;
const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} };

// ---------- tool specs ----------
export function mcpToolSpecs(client: McpClient): ToolSpec[] {
  return client.tools.map((t) => toolSpec(client, t));
}

/** Tool names may only use [a-zA-Z0-9_-] and are capped in length. */
export function safeMcpName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME_CHARS);
}

// ---------- helpers ----------
function toolSpec(client: McpClient, t: McpToolInfo): ToolSpec {
  const resource = `${client.name}/${t.name}`;
  return {
    name: safeMcpName(`${client.name}_${t.name}`),
    description: describe(client, t),
    schema: z.record(z.string(), z.unknown()),
    jsonSchema:
      t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : EMPTY_OBJECT_SCHEMA,
    permissionKey: "mcp",
    deferrable: true,
    readonly: t.annotations?.readOnlyHint === true,
    permissions: () => [
      {
        permission: "mcp",
        patterns: [resource],
        always: [resource, `${client.name}/*`],
        title: `MCP ${client.name} → ${t.name}`,
      },
    ],
    async execute(input, ctx) {
      const r = await client.call(t.name, input, ctx.signal);
      if (r.isError) throw new Error(r.text || `MCP tool ${t.name} failed`);
      return {
        output: r.text || "(no output)",
        title: resource,
        metadata: { server: client.name },
      };
    },
  };
}

function describe(client: McpClient, t: McpToolInfo): string {
  const summary = t.description ?? t.annotations?.title ?? t.name;
  return `${summary} (MCP server "${client.name}")`.slice(0, MAX_DESCRIPTION_CHARS);
}
