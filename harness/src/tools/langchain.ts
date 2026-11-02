// LangChain adapter — exposes our tool classes as LangChain.js StructuredTools.
// Adoption, not a shift: the classes in ./read.ts … ./shell.ts stay the source
// of truth (validation, hooks, truncation). This file only translates them so a
// future LangGraph loop can call them; ToolRegistry behavior is unchanged.
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { EditTool } from "./edit.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { ReadTool } from "./read.js";
import { ShellTool } from "./shell.js";
import { BaseTool } from "./tool.js";
import { WriteTool } from "./write.js";

/** Zod input shape per tool — mirrors the validation already inside each class. */
export const TOOL_SCHEMAS = {
  read: z.object({ path: z.string().min(1) }),
  write: z.object({ path: z.string().min(1), content: z.string() }),
  edit: z.object({ path: z.string().min(1), oldString: z.string(), newString: z.string() }),
  glob: z.object({ pattern: z.string().min(1) }),
  grep: z.object({ pattern: z.string().min(1), dir: z.string().min(1).optional() }),
  shell: z.object({ cmd: z.string().min(1) }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

/** Wrap one of our tools. Non-string results are JSON-encoded (tools return text). */
export function toStructuredTool(
  tool: BaseTool<Record<string, unknown>, unknown>,
  schema: z.ZodTypeAny,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description,
    schema,
    func: async (input: Record<string, unknown>): Promise<string> => {
      const out = await tool.execute(input);
      return typeof out === "string" ? out : JSON.stringify(out);
    },
  });
}

/** Default singletons, wrapped. Pass a custom ShellTool(hooks) to override approvals. */
export function langchainTools(overrides?: { shellTool?: ShellTool }): DynamicStructuredTool[] {
  const tools: Array<{ tool: BaseTool<Record<string, unknown>, unknown>; schema: z.ZodTypeAny }> = [
    { tool: new ReadTool(), schema: TOOL_SCHEMAS.read },
    { tool: new WriteTool(), schema: TOOL_SCHEMAS.write },
    { tool: new EditTool(), schema: TOOL_SCHEMAS.edit },
    { tool: new GlobTool(), schema: TOOL_SCHEMAS.glob },
    { tool: new GrepTool(), schema: TOOL_SCHEMAS.grep },
    { tool: overrides?.shellTool ?? new ShellTool(), schema: TOOL_SCHEMAS.shell },
  ];
  return tools.map(({ tool, schema }) => toStructuredTool(tool, schema));
}
