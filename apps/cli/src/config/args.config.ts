// Command-line flags and the `exa --help` text.

import { resolve } from "node:path";
import { parseArgs } from "node:util";

// ---------- constants ----------
export const HELP = `exa — AI coding agent (heavy client)

Usage:
  exa [flags]                 interactive session
  exa -p "prompt" [flags]     one-shot
  exa login [--server URL]    device login (opens a code to approve in the browser)
  exa login --dev --email you@x.dev --tenant acme [--server URL]
  exa logout | whoami | sessions | usage
  exa keys                    list your provider keys (BYOK)
  exa keys add <provider>     add a key (anthropic, openai, openrouter, google, groq, bedrock, ...)

Flags:
  --local              run without a server (uses provider keys from env / --env-file)
  -m, --model M        "exa", "exa/fast|balanced|strong" or "<provider>/<model>"
  --agent A            build | plan
  --mode M             default | accept-edits | plan | bypass
  --storage S          none | local | server (server mode decides within org policy)
  -r, --resume ID      resume a session
  --cwd DIR            workspace (default: current directory)
  --env-file F         KEY=VALUE file with provider keys (local mode)
  -y, --yes            auto-approve "ask" prompts (deny rules still apply)
`;

const OPTIONS = {
  p: { type: "string", short: "p" },
  print: { type: "string" },
  local: { type: "boolean" },
  model: { type: "string", short: "m" },
  agent: { type: "string" },
  mode: { type: "string" },
  storage: { type: "string" },
  resume: { type: "string", short: "r" },
  cwd: { type: "string" },
  "env-file": { type: "string" },
  server: { type: "string" },
  dev: { type: "boolean" },
  email: { type: "string" },
  tenant: { type: "string" },
  yes: { type: "boolean", short: "y" },
  thinking: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

// ---------- types ----------
export type CliFlags = ReturnType<typeof parse>["values"];

export interface CliArgs {
  flags: CliFlags;
  positionals: string[];
}

// ---------- parsing ----------
/** Parse argv (without the runtime and script path). Throws on unknown flags. */
export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parse(argv);
  return { flags: values, positionals };
}

/** Workspace directory from --cwd, defaulting to the current directory. */
export function resolveCwd(p?: string): string {
  return resolve(p ?? process.cwd());
}

// ---------- helpers ----------
function parse(args: string[]) {
  return parseArgs({ args, allowPositionals: true, options: OPTIONS });
}
