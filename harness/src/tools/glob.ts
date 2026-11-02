// Tool: glob — readonly file pattern match (Bun.Glob). Arg shapes in ./types.ts.
import { Glob } from "bun";
import { BaseTool } from "./tool.js";
import type { GlobArgs } from "./types.js";

export class GlobTool extends BaseTool<GlobArgs, string[]> {
  readonly name = "glob";
  readonly description = "Match files by glob pattern";
  readonly readonly = true;

  async execute(args: GlobArgs): Promise<string[]> {
    if (typeof args.pattern !== "string" || args.pattern.length === 0) {
      throw new Error("glob: pattern must be a non-empty string");
    }
    const glob = new Glob(args.pattern);
    const out: string[] = [];
    for await (const f of glob.scan(".")) {
      out.push(f);
      if (out.length > 200) break;
    }
    return out;
  }
}

export const globTool = new GlobTool();
