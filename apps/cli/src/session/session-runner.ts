// `exa` / `exa -p`: start a client session, then run one prompt or the interactive REPL.

import { createInterface, type Interface as RlInterface } from "node:readline/promises";
import type { PermissionMode, StorageMode } from "@exa/protocol";
import { type CliFlags, resolveCwd } from "../config/args.config.ts";
import { loadLocalConfig } from "../config/exa-home.config.ts";
import { readEnvFile } from "../helpers/env-file.helper.ts";
import type { Credentials, LocalConfig } from "../models/config.model.ts";
import { makeInteraction } from "../repl/interaction.ts";
import { type ReplContext, runRepl } from "../repl/repl.ts";
import { ApiError } from "../services/api.service.ts";
import { Ui } from "../ui/terminal-ui.ts";
import { type ClientOptions, ExaClient } from "./exa-client.ts";

// ---------- constants ----------
const HTTP_UNAUTHORIZED = 401;

// ---------- session runner ----------
export async function runSession(flags: CliFlags, creds: Credentials | null): Promise<void> {
  const local = await loadLocalConfig();
  const env = await resolveEnv(flags);
  const ui = new Ui();
  ui.showThinking = !!flags.thinking;
  const oneShot = flags.p ?? flags.print;
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
  });
  const autoYes = !!flags.yes;
  const io = makeInteraction({ ui, rl, autoYes, isOneShot: !!oneShot, hasServer: !!creds });
  const client = new ExaClient(clientOptions(flags, local, env), io, creds);
  await startClient(client, rl);
  ui.rootSessionId = client.session.id;
  const shutdown = makeShutdown(rl, client);

  const ctx: ReplContext = { client, ui, rl, autoYes, shutdown };
  if (oneShot) return runOneShot(ctx, oneShot);
  await runRepl(ctx, { creds, isResumed: !!flags.resume });
}

// ---------- helpers ----------
async function resolveEnv(flags: CliFlags): Promise<Record<string, string | undefined>> {
  if (!flags["env-file"]) return process.env;
  return { ...process.env, ...(await readEnvFile(flags["env-file"])) };
}

/** Flags win over ~/.exa/config.json. */
function clientOptions(
  flags: CliFlags,
  local: LocalConfig,
  env: Record<string, string | undefined>,
): ClientOptions {
  return {
    cwd: resolveCwd(flags.cwd),
    model: flags.model ?? local.model,
    agent: flags.agent ?? local.agent,
    mode: (flags.mode ?? local.permissionMode) as PermissionMode | undefined,
    storage: (flags.storage ?? local.storageMode) as StorageMode | undefined,
    resume: flags.resume,
    env,
    localRules: local.rules,
    instructions: local.instructions,
  };
}

async function startClient(client: ExaClient, rl: RlInterface): Promise<void> {
  try {
    await client.start();
  } catch (e) {
    rl.close();
    if (e instanceof ApiError && e.status === HTTP_UNAUTHORIZED)
      throw new Error("your login expired or was revoked — run `exa login`");
    throw e;
  }
}

/** Idempotent: close the terminal, release the session, then exit. */
function makeShutdown(rl: RlInterface, client: ExaClient): ReplContext["shutdown"] {
  let isClosing = false;
  return async (code = 0) => {
    if (isClosing) return;
    isClosing = true;
    rl.close();
    await client.close();
    process.exit(code);
  };
}

async function runOneShot({ client, ui, shutdown }: ReplContext, text: string): Promise<void> {
  ui.beginTurn();
  const r = await client.prompt(text);
  ui.line();
  ui.endTurn();
  await shutdown(r.finish === "error" ? 1 : 0);
}
