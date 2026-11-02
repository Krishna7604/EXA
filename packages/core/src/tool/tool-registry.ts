// Tool registry: the set of tools a loop can call, and their cached model-facing definitions.

import type { ToolDef } from "@exa/protocol";
import { z } from "zod";
import type { ToolSpec } from "../models/tool.model.ts";

// ---------- tool registry ----------
export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly defsCache = new Map<string, ToolDef>();

  constructor(tools: ToolSpec[] = []) {
    for (const t of tools) this.register(t);
  }

  register(tool: ToolSpec): this {
    // Same name overrides (custom tools can replace built-ins).
    this.tools.set(tool.name, tool);
    this.defsCache.delete(tool.name);
    return this;
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.defsCache.delete(name);
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  definition(name: string): ToolDef | undefined {
    const cached = this.defsCache.get(name);
    if (cached) return cached;
    const t = this.tools.get(name);
    if (!t) return undefined;
    const schema = t.jsonSchema ? { ...t.jsonSchema } : modelSchema(t.schema);
    delete schema.$schema;
    const def: ToolDef = { name: t.name, description: t.description, parameters: schema };
    this.defsCache.set(name, def);
    return def;
  }

  definitions(filter?: (name: string) => boolean): ToolDef[] {
    return this.names()
      .filter((n) => !filter || filter(n))
      .map((n) => this.definition(n)!)
      .filter(Boolean);
  }
}

// ---------- helpers ----------
/** The JSON schema the model sees: draft-7, describing the input side of the zod schema. */
function modelSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
}
