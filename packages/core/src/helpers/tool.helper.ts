// Helpers for tool authors: typed tool declaration and model-readable input errors.

import type { z } from "zod";
import type { ToolContext, ToolResult, ToolSpec } from "../models/tool.model.ts";
import type { PermissionAsk } from "../permission/permission-gate.ts";

// ---------- tool contract ----------
export function defineTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  permissionKey?: string;
  readonly: boolean;
  permissions(input: z.infer<S>, ctx: ToolContext): PermissionAsk[] | Promise<PermissionAsk[]>;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}): ToolSpec<z.infer<S>> & { permissionKey?: string } {
  return spec as unknown as ToolSpec<z.infer<S>>;
}

// ---------- validation errors ----------
/** Format zod issues for the model so it can fix its own call. */
export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
