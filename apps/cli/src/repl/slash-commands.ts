// REPL slash commands (/model, /undo, /cost, ...) plus custom commands from .exa/commands.

import type { PermissionMode } from "@exa/protocol";
import type { CommandDef } from "@exa/tools";
import { color } from "../ui/color.ts";
import type { ReplContext } from "./repl.ts";

// ---------- constants ----------
const HELP_LINES = [
  "  /model [slug]     show or switch model (exa, exa/fast, openai/gpt-5 …)",
  "  /agent [name]     build | plan",
  "  /mode [mode]      default | accept-edits | plan | bypass",
  "  /undo             revert the last turn (files + conversation)",
  "  /redo             restore what /undo removed",
  "  /compact          summarize the conversation to free context",
  "  /sessions         recent sessions",
  "  /agents           available agents (add .exa/agents/<name>.md)",
  "  /commands         custom commands (add .exa/commands/<name>.md)",
  "  /cost             tokens + cost for this session",
  "  /thinking         toggle showing model reasoning",
  "  /exit             quit",
];
const EXIT_COMMANDS = new Set(["exit", "quit"]);
const UNDO_PREVIEW_CHARS = 80;
const AGENT_NAME_WIDTH = 12;
const AGENT_DESCRIPTION_CHARS = 90;
const COST_DECIMALS = 4;

// ---------- types ----------
type SlashHandler = (ctx: ReplContext, arg: string) => Promise<void>;

// ---------- handlers ----------
const BUILTIN = new Map<string, SlashHandler>([
  ["help", showHelp],
  ["model", modelCommand],
  ["agent", agentCommand],
  ["mode", modeCommand],
  ["undo", undoCommand],
  ["redo", redoCommand],
  ["compact", compactCommand],
  ["sessions", sessionsCommand],
  ["cost", costCommand],
  ["thinking", thinkingCommand],
  ["commands", commandsCommand],
  ["agents", agentsCommand],
]);

// ---------- dispatch ----------
/** Run one `/command args` line. Returns true when the REPL should stop. */
export async function runSlashCommand(ctx: ReplContext, line: string): Promise<boolean> {
  const [name, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  const handler = BUILTIN.get(name);
  try {
    if (EXIT_COMMANDS.has(name)) {
      await ctx.shutdown(0);
      return true;
    }
    if (handler) await handler(ctx, arg);
    else await runCustomCommand(ctx, name, arg);
  } catch (e) {
    ctx.ui.line(color.red(`  ✗ ${(e as Error).message}`));
  }
  return false;
}

// ---------- helpers ----------
async function showHelp({ ui }: ReplContext): Promise<void> {
  ui.line(HELP_LINES.join("\n"));
}

async function modelCommand({ client, ui }: ReplContext, arg: string): Promise<void> {
  if (!arg) return ui.line(`  model: ${client.session.model}`);
  await client.setModel(arg);
  ui.line(`  model → ${arg}`);
}

async function agentCommand({ client, ui }: ReplContext, arg: string): Promise<void> {
  if (arg) client.agent = arg;
  ui.line(`  agent: ${client.agent}`);
}

async function modeCommand({ client, ui }: ReplContext, arg: string): Promise<void> {
  if (arg) await client.setMode(arg as PermissionMode);
  ui.line(`  mode: ${client.mode}`);
}

async function undoCommand({ client, ui }: ReplContext): Promise<void> {
  const text = await client.undo();
  if (text === null) return ui.line("  nothing to undo");
  ui.line(`  ↺ reverted: ${color.gray(text.slice(0, UNDO_PREVIEW_CHARS))}`);
}

async function redoCommand({ client, ui }: ReplContext): Promise<void> {
  await client.redo();
  ui.line("  ↻ restored");
}

async function compactCommand({ client, ui }: ReplContext): Promise<void> {
  ui.line((await client.compact()) ? "  ⇢ compacted" : "  nothing to compact");
}

async function sessionsCommand({ client, ui }: ReplContext): Promise<void> {
  for (const s of await client.listSessions())
    ui.line(`  ${color.gray(s.id)} ${s.title ?? "(untitled)"}`);
}

async function costCommand({ client, ui }: ReplContext): Promise<void> {
  const { tokens, cost } = client.session;
  ui.line(`  ${tokens.input} in / ${tokens.output} out · $${cost.toFixed(COST_DECIMALS)}`);
}

async function thinkingCommand({ ui }: ReplContext): Promise<void> {
  ui.showThinking = !ui.showThinking;
  ui.line(`  thinking ${ui.showThinking ? "shown" : "hidden"}`);
}

async function commandsCommand({ client, ui }: ReplContext): Promise<void> {
  for (const k of client.commands) ui.line(`  /${k.name}  ${color.gray(k.description)}`);
  if (!client.commands.length)
    ui.line(color.gray("  no custom commands (add .exa/commands/<name>.md)"));
}

async function agentsCommand({ client, ui }: ReplContext): Promise<void> {
  for (const a of client.agents.list().filter((x) => !x.hidden)) {
    const details = `${a.mode} · ${a.description.slice(0, AGENT_DESCRIPTION_CHARS)}`;
    ui.line(`  ${a.name.padEnd(AGENT_NAME_WIDTH)} ${color.gray(details)}`);
  }
}

/** Expand a .exa/commands/<name>.md command and run it as a turn (with its agent, if set). */
async function runCustomCommand(ctx: ReplContext, name: string, arg: string): Promise<void> {
  const { client, ui } = ctx;
  const custom = client.commands.find((k) => k.name === name);
  if (!custom) return ui.line(color.yellow(`  unknown command /${name} — /help`));
  const text = await client.expandCommand(custom, arg, (sh) => confirmShell(ctx, sh, name));
  ui.beginTurn();
  await promptWithAgent(ctx, custom, text);
  ui.line();
  ui.endTurn();
}

async function confirmShell(ctx: ReplContext, sh: string, name: string): Promise<boolean> {
  if (ctx.autoYes) return true;
  const answer = (await ctx.rl.question(`  run \`${sh}\` for /${name}? [y/N] › `))
    .trim()
    .toLowerCase();
  return answer === "y" || answer === "yes";
}

/** Prompt with the command's agent, restoring the previous agent afterwards. */
async function promptWithAgent(
  { client }: ReplContext,
  custom: CommandDef,
  text: string,
): Promise<void> {
  const prevAgent = client.agent;
  if (custom.agent) client.agent = custom.agent;
  try {
    await client.prompt(text);
  } finally {
    client.agent = prevAgent;
  }
}
