// Hooks — approval gates (Claude Code pattern: readonly vs destructive).
// Types live in ./types.ts.
import type { Verdict } from "./types.js";
import { JevClient } from "./router/typesafe.js";

export class HookManager {
  private readonly blocked: RegExp[] = [/rm\s+-rf/, /mkfs/, /\bdd\b.*of=\/dev/, /git\s+push\s+--force/];

  constructor(private readonly jev: JevClient | null = null) {}

  async onPreToolUse(tool: string, args: Record<string, unknown>): Promise<Verdict> {
    const serialized = `${tool} ${JSON.stringify(args)}`;
    if (this.blocked.some((re) => re.test(serialized))) return { allow: false, reason: `blocked destructive pattern in ${tool}` };
    if (tool === "shell" && this.jev?.isAvailable()) {
      const r = await this.jev.decideSafe(String(args.cmd ?? ""), {
        destructive: {
          type: "noul",
          instructions: "Is this shell command destructive, irreversible, or broader than a normal read/build task?",
          criteria: { destructive: "deletes data, force-pushes, drops tables, or modifies system state", safe: "read-only, build, test, or local scratch work" },
        },
      });
      const p = r?.answers?.destructive?.noul;
      if (typeof p === "number" && p >= 0.8) {
        return { allow: false, reason: `jev rated this command ${(p * 100).toFixed(0)}% destructive — blocked` };
      }
      if (typeof p === "number" && p <= 0.2) return { allow: true };
    }
    if (tool === "shell") return { allow: "ask-human", reason: "shell is destructive by default — confirm in Phase 1 TUI" };
    return { allow: true };
  }
}

export const defaultHooks = new HookManager();

export async function onPreToolUse(tool: string, args: Record<string, unknown>): Promise<Verdict> {
  return defaultHooks.onPreToolUse(tool, args);
}
