// bash: run a shell command in the workspace. Permissions come from bashAsks (per parsed
// subcommand); the child runs through a ShellRunner with a scrubbed environment, and live
// output is streamed to the UI while it runs.

import { defineTool, type ToolContext } from "@exa/core";
import { z } from "zod";
import { resolvePath } from "../../helpers/paths.helper.ts";
import { bashAsks } from "./bash-asks.ts";
import { localShell, type ShellRunner } from "./local-shell.ts";

// ---------- constants ----------
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MIN_TIMEOUT = 1000;
const MS_PER_SECOND = 1000;
/** Minimum gap between live-output UI updates. */
const LIVE_UPDATE_INTERVAL_MS = 250;
/** How much of the tail of live output each UI update carries. */
const LIVE_TAIL_CHARS = 2000;
const MAX_TITLE_CHARS = 80;

// ---------- types ----------
interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  workdir?: string;
}

// ---------- bash tool ----------
export const bashTool = defineTool({
  name: "bash",
  description:
    "Run a shell command in the workspace and return its combined stdout/stderr and exit code. " +
    "Use for builds, tests, git, package managers. Do NOT use it for reading/searching/editing files — use read, grep, glob, edit. " +
    "Quote paths with spaces. Prefer `&&` chains over multiple calls when steps depend on each other. " +
    `Default timeout ${DEFAULT_TIMEOUT / MS_PER_SECOND}s (max ${MAX_TIMEOUT / MS_PER_SECOND}s). Interactive commands are not supported.`,
  schema: z.object({
    command: z.string().min(1).describe("The command to run"),
    description: z.string().max(200).optional().describe("5-10 word description of what this does"),
    timeout: z
      .number()
      .int()
      .min(MIN_TIMEOUT)
      .max(MAX_TIMEOUT)
      .optional()
      .describe("Timeout in ms"),
    workdir: z.string().optional().describe("Directory to run in (default: working directory)"),
  }),
  readonly: false,
  permissions: (input, ctx) => bashAsks(input.command, ctx, input.workdir),
  async execute(input, ctx) {
    const runner = (ctx.services.shell as ShellRunner | false | undefined) ?? localShell;
    if (runner === false) throw new Error("Shell commands are not available in this environment.");
    const cwd = input.workdir ? resolvePath(ctx, input.workdir).abs : ctx.cwd;
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT;
    const res = await runner.run(input.command, {
      cwd,
      timeoutMs,
      signal: ctx.signal,
      onOutput: liveOutputReporter(input, ctx),
    });
    const output = withStatusNotes(res, timeoutMs, ctx.signal.aborted);
    return {
      output: output || "(no output)",
      title: titleFor(input),
      metadata: { exit: res.exitCode, timedOut: res.timedOut, command: input.command },
    };
  },
});

// ---------- helpers ----------
function titleFor(input: BashInput): string {
  return input.description ?? input.command.slice(0, MAX_TITLE_CHARS);
}

/** Streams the tail of the output to ctx.update, throttled to LIVE_UPDATE_INTERVAL_MS. */
function liveOutputReporter(input: BashInput, ctx: ToolContext): (chunk: string) => void {
  let live = "";
  let lastUpdate = 0;
  return (chunk) => {
    live += chunk;
    const now = Date.now();
    if (now - lastUpdate <= LIVE_UPDATE_INTERVAL_MS) return;
    lastUpdate = now;
    ctx.update?.({ title: titleFor(input), metadata: { output: live.slice(-LIVE_TAIL_CHARS) } });
  };
}

/** Trimmed output plus bracketed notes for timeout, user abort and non-zero exit. */
function withStatusNotes(
  res: { output: string; exitCode: number | null; timedOut: boolean },
  timeoutMs: number,
  isAborted: boolean,
): string {
  let output = res.output.trimEnd();
  if (res.timedOut)
    output += `\n\n[command timed out after ${timeoutMs / MS_PER_SECOND}s and was killed]`;
  if (isAborted) output += "\n\n[command aborted by the user]";
  if (res.exitCode !== 0 && res.exitCode !== null) output += `\n\n[exit code ${res.exitCode}]`;
  return output;
}
