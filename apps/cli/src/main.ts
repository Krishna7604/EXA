#!/usr/bin/env -S bun --no-env-file

// exa — heavy client CLI entry point: parses flags and dispatches to a subcommand.
//   exa                      interactive session (server if logged in, else local mode)
//   exa -p "prompt"          one-shot, prints the answer
//   exa login [--server URL] [--dev --email E --tenant T]
//   exa logout | exa whoami | exa sessions | exa keys [add <provider>] | exa usage
//   flags: --local --model M --agent A --mode default|accept-edits|plan|bypass
//          --storage none|local|server --resume <id> --cwd DIR --env-file F --yes

import { login, logout, whoami } from "./commands/auth.command.ts";
import { keysCommand } from "./commands/keys.command.ts";
import { listSessions } from "./commands/sessions.command.ts";
import { showUsage } from "./commands/usage.command.ts";
import { type CliArgs, HELP, parseCliArgs } from "./config/args.config.ts";
import { loadCredentials } from "./config/exa-home.config.ts";
import { ExaApi } from "./services/api.service.ts";
import { runSession } from "./session/session-runner.ts";
import { color } from "./ui/color.ts";

// ---------- entry ----------
const args = parseCliArgs(Bun.argv.slice(2));

main(args).catch((e) => {
  console.error(color.red(`exa: ${(e as Error).message}`));
  process.exit(1);
});

// ---------- dispatch ----------
async function main({ flags, positionals }: CliArgs): Promise<void> {
  if (flags.help) return void console.log(HELP);
  const cmd = positionals[0];
  if (cmd === "login") return login(flags);
  if (cmd === "logout") return logout();
  const creds = flags.local ? null : await loadCredentials();
  const api = creds ? new ExaApi(creds.server, creds.token) : null;
  if (cmd === "whoami") return whoami(api, creds);
  if (cmd === "sessions") return listSessions(api);
  if (cmd === "usage") return showUsage(api);
  if (cmd === "keys") return keysCommand(api, positionals.slice(1));
  if (cmd && cmd !== "run") {
    console.error(`unknown command "${cmd}"\n`);
    return void console.log(HELP);
  }
  await runSession(flags, creds);
}
