// Tool: write — destructive (needs approval). Arg shapes live in ./types.ts.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BaseTool } from "./tool.js";
import type { WriteArgs } from "./types.js";

export class WriteTool extends BaseTool<WriteArgs, string> {
  readonly name = "write";
  readonly description = "Write a file (creates parent dirs)";
  readonly readonly = false;

  async execute(args: WriteArgs): Promise<string> {
    if (typeof args.path !== "string" || args.path.length === 0) throw new Error("write: path must be a non-empty string");
    if (typeof args.content !== "string") throw new Error("write: content must be a string");
    await mkdir(dirname(args.path), { recursive: true });
    await writeFile(args.path, args.content, "utf8");
    return `wrote ${args.path} (${args.content.length} chars)`;
  }
}

export const writeTool = new WriteTool();
