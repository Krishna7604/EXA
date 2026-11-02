// Tool: read — readonly. Phase 1 adds Zod schema + approval wiring.
// Arg shapes live in ./types.ts.
import { readFile } from "node:fs/promises";
import { BaseTool } from "./tool.js";
import type { ReadArgs } from "./types.js";

export class ReadTool extends BaseTool<ReadArgs, string> {
  readonly name = "read";
  readonly description = "Read a file";
  readonly readonly = true;

  async execute(args: ReadArgs): Promise<string> {
    if (typeof args.path !== "string" || args.path.length === 0) throw new Error("read: path must be a non-empty string");
    return readFile(args.path, "utf8");
  }
}

export const readTool = new ReadTool();
