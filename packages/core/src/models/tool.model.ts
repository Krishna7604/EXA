// Tool contract. A tool declares its schema (zod → JSON schema for the model), the
// permissions a call needs, and how to execute. Executors (local machine, server sandbox)
// are just registries of these with a different ToolContext.root.

import type { z } from "zod";
import type { PermissionAsk } from "../permission/permission-gate.ts";

// ---------- types ----------
export interface ToolContext {
  sessionId: string;
  messageId: string;
  callId: string;
  agent: string;
  /** Workspace root; path tools resolve against it and flag anything outside. */
  root: string;
  cwd: string;
  signal: AbortSignal;
  /** Where oversized outputs are offloaded. */
  outputDir: string;
  /** Subagent nesting depth of the running loop. */
  depth: number;
  /** Live title/metadata updates while running (e.g. streaming bash output). */
  update?: (u: { title?: string; metadata?: Record<string, unknown> }) => void;
  /** Escape hatch for executor-specific services (sandbox handle, skills, todo store...). */
  services: Record<string, unknown>;
}

export interface ToolResult {
  output: string;
  title: string;
  metadata?: Record<string, unknown>;
}

export interface ToolSpec<I = any> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  /** Permission key when it differs from the name (write/edit/apply_patch → "edit"). */
  permissionKey?: string;
  /** May be listed by name only and loaded on demand via tool_search (external/MCP tools). */
  deferrable?: boolean;
  /** Raw JSON schema sent to the model (external tools, e.g. MCP); `schema` then only validates loosely. */
  jsonSchema?: Record<string, unknown>;
  /** Read-only tools may run in parallel within one step. */
  readonly: boolean;
  permissions(input: I, ctx: ToolContext): PermissionAsk[] | Promise<PermissionAsk[]>;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}
