// Interactive session: banner, prompt loop and Ctrl+C / Ctrl+D handling.

import type { Interface as RlInterface } from "node:readline/promises";
import type { Credentials } from "../models/config.model.ts";
import type { ExaClient } from "../session/exa-client.ts";
import { color } from "../ui/color.ts";
import type { Ui } from "../ui/terminal-ui.ts";
import { runSlashCommand } from "./slash-commands.ts";

// ---------- constants ----------
const PROMPT = "exa › ";

// ---------- types ----------
/** Everything a REPL turn or slash command needs. */
export interface ReplContext {
  client: ExaClient;
  ui: Ui;
  rl: RlInterface;
  autoYes: boolean;
  /** Close the terminal and the session, then exit the process. */
  shutdown: (code?: number) => Promise<void>;
}

export interface WelcomeInfo {
  creds: Credentials | null;
  isResumed: boolean;
}

// ---------- repl ----------
export async function runRepl(ctx: ReplContext, welcome: WelcomeInfo): Promise<void> {
  printWelcome(ctx, welcome);
  bindSignals(ctx);
  for (;;) {
    const line = await readLine(ctx.rl);
    if (line === null) break;
    if (!line) continue;
    if (line.startsWith("/")) {
      const shouldExit = await runSlashCommand(ctx, line);
      if (shouldExit) return;
      continue;
    }
    await runPromptTurn(ctx, line);
  }
  await ctx.shutdown(0);
}

// ---------- helpers ----------
function printWelcome({ client, ui }: ReplContext, { creds, isResumed }: WelcomeInfo): void {
  ui.banner({
    mode: client.mode,
    model: client.session.model,
    cwd: client.session.directory ?? process.cwd(),
    storage: client.session.storageMode,
    server: creds?.server,
    tenant: creds?.tenant,
    agent: client.agent,
  });
  if (isResumed) ui.line(color.gray(`  resumed ${client.session.title ?? client.session.id}`));
  if (client.mcpSummary) ui.line(color.gray(`  mcp: ${client.mcpSummary}`));
}

/** Ctrl+C aborts a running turn (or quits when idle); Ctrl+D quits. */
function bindSignals({ client, ui, rl, shutdown }: ReplContext): void {
  rl.on("SIGINT", () => {
    if (client.abort()) ui.line(color.yellow("  ⏹ aborting…"));
    else void shutdown(0);
  });
  rl.on("close", () => void shutdown(0));
}

/** Trimmed input line, or null once the terminal is closed. */
async function readLine(rl: RlInterface): Promise<string | null> {
  try {
    return (await rl.question(color.cyan(PROMPT))).trim();
  } catch {
    return null;
  }
}

async function runPromptTurn({ client, ui }: ReplContext, text: string): Promise<void> {
  ui.beginTurn();
  try {
    await client.prompt(text);
  } catch (e) {
    ui.line(color.red(`  ✗ ${(e as Error).message}`));
  }
  ui.line();
  ui.endTurn();
}
