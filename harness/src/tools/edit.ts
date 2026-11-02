// Tool: edit — destructive (needs approval). Exact-string replace.
// Arg shapes live in ./types.ts.
import { readFile, writeFile } from "node:fs/promises";
import { BaseTool } from "./tool.js";
import type { EditArgs } from "./types.js";

export class EditTool extends BaseTool<EditArgs, string> {
  readonly name = "edit";
  readonly description = "Exact string replace in a file";
  readonly readonly = false;

  async execute(args: EditArgs): Promise<string> {
    if (typeof args.path !== "string" || args.path.length === 0) throw new Error("edit: path must be a non-empty string");
    if (typeof args.oldString !== "string" || typeof args.newString !== "string") {
      throw new Error("edit: oldString and newString must be strings");
    }
    const cur = await readFile(args.path, "utf8");
    if (!cur.includes(args.oldString)) throw new Error("oldString not found");
    await writeFile(args.path, cur.replace(args.oldString, args.newString), "utf8");
    return `edited ${args.path}`;
  }
}

export const editTool = new EditTool();
