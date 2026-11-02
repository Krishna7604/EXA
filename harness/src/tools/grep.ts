// Tool: grep — readonly content search (pure TS stub; Phase 1 can shell to rg).
// Arg shapes live in ./types.ts.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BaseTool } from "./tool.js";
import type { GrepArgs } from "./types.js";

export class GrepTool extends BaseTool<GrepArgs, string[]> {
  readonly name = "grep";
  readonly description = "Search file contents for a regex";
  readonly readonly = true;

  async execute(args: GrepArgs): Promise<string[]> {
    if (typeof args.pattern !== "string" || args.pattern.length === 0) {
      throw new Error("grep: pattern must be a non-empty string");
    }
    const dir = typeof args.dir === "string" && args.dir.length > 0 ? args.dir : ".";
    const re = new RegExp(args.pattern);
    const hits: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d)) {
        if (e.startsWith(".") || e === "node_modules") continue;
        const p = join(d, e);
        const s = await stat(p);
        if (s.isDirectory()) {
          if (hits.length < 100) await walk(p);
        } else if (/\.(ts|js|json|md|py)$/.test(e)) {
          try {
            const t = await readFile(p, "utf8");
            t.split("\n").forEach((line, i) => {
              if (re.test(line) && hits.length < 100) hits.push(`${p}:${i + 1}:${line.slice(0, 200)}`);
            });
          } catch {
            // skip unreadable files
          }
        }
      }
    };
    await walk(dir);
    return hits;
  }
}

export const grepTool = new GrepTool();
