// Tool: shell — destructive, ALWAYS goes through HookManager.
// Arg shapes live in ./types.ts.
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { defaultHooks, type HookManager } from "../hooks.js";
import { BaseTool } from "./tool.js";
import type { ShellArgs } from "./types.js";

const sh = promisify(exec);

export class ShellTool extends BaseTool<ShellArgs, string> {
  readonly name = "shell";
  readonly description = "Run a shell command (destructive — requires approval)";
  readonly readonly = false;

  constructor(private readonly hooks: HookManager = defaultHooks) {
    super();
  }

  async execute(args: ShellArgs): Promise<string> {
    if (typeof args.cmd !== "string" || args.cmd.length === 0) {
      throw new Error("shell: cmd must be a non-empty string");
    }
    const verdict = await this.hooks.onPreToolUse("shell", { cmd: args.cmd });
    if (verdict.allow === false) throw new Error(`blocked: ${verdict.reason}`);
    if (verdict.allow === "ask-human") console.log(`[hooks] approval needed: ${verdict.reason} — auto-allow in Phase 0 stub`);
    const { stdout, stderr } = await sh(args.cmd, { timeout: 120_000 });
    return (stdout + stderr).slice(0, 8000);
  }
}

export const shellTool = new ShellTool();
