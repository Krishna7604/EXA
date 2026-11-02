// Tool registry — class instances compose here. Phase 1 converts these to
// Zod `tool()` defs for callModel; the registry stays the lookup point.
export { BaseTool, ToolRegistry } from "./tool.js";
export { ReadTool, readTool } from "./read.js";
export { WriteTool, writeTool } from "./write.js";
export { EditTool, editTool } from "./edit.js";
export { GlobTool, globTool } from "./glob.js";
export { GrepTool, grepTool } from "./grep.js";
export { ShellTool, shellTool } from "./shell.js";
export { langchainTools, toStructuredTool, TOOL_SCHEMAS, type ToolName } from "./langchain.js";

import { ToolRegistry } from "./tool.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { shellTool } from "./shell.js";

export const tools = [readTool, writeTool, editTool, globTool, grepTool, shellTool];

export const toolRegistry = new ToolRegistry(tools);
