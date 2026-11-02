// Built-in command risk classifier. Runs only on the server, so a client loop can't skip it:
// flags shell commands that are destructive, exfiltrate credentials or change shared infra.

import { parseShell } from "@exa/core";

// ---------- types ----------
export interface Risk {
  action: "deny" | "ask";
  reason: string;
}

// ---------- constants ----------
const PIPE_INTO_SHELL = /\|\s*(ba|z)?sh\b/;
const REMOTE_FETCH = /\b(curl|wget)\b/;
const PIPE_REMOTE_SCRIPT: Risk = { action: "deny", reason: "pipe remote script into a shell" };

const RISKS: Array<[RegExp, Risk]> = [
  [
    /^rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\/\*|\.\.?\/?)\s*$/,
    { action: "deny", reason: "recursive delete of a root/home directory" },
  ],
  [/^rm\s+.*--no-preserve-root/, { action: "deny", reason: "rm --no-preserve-root" }],
  [
    /^(mkfs|mkfs\.\w+|fdisk|parted|wipefs)\b/,
    { action: "deny", reason: "disk formatting/partitioning" },
  ],
  [/^dd\s+.*\bof=\/dev\//, { action: "deny", reason: "raw write to a device" }],
  [/^:\s*\(\s*\)\s*\{/, { action: "deny", reason: "fork bomb" }],
  [/^(shutdown|reboot|halt|poweroff)\b/, { action: "deny", reason: "power state change" }],
  [/^chmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, { action: "deny", reason: "world-writable root" }],
  [/^git\s+push\s+.*(--force|-f)(\s|$)/, { action: "ask", reason: "force push" }],
  [/^git\s+(reset\s+--hard|clean\s+-[a-z]*f)/, { action: "ask", reason: "discards local changes" }],
  [/^(curl|wget)\b.*\|\s*(ba|z)?sh\b/, PIPE_REMOTE_SCRIPT],
  [/^(npm|pnpm|yarn|bun)\s+publish\b/, { action: "ask", reason: "publishes a package" }],
  [/^(terraform|tofu)\s+(apply|destroy)\b/, { action: "ask", reason: "infrastructure change" }],
  [/^kubectl\s+(delete|apply|drain|scale)\b/, { action: "ask", reason: "cluster change" }],
  [
    /^(aws|gcloud|az)\s+.*\b(delete|destroy|terminate|rm)\b/,
    { action: "ask", reason: "cloud resource deletion" },
  ],
  [/^(drop|truncate)\s+(table|database|schema)\b/i, { action: "ask", reason: "destructive SQL" }],
  [
    /\b(psql|mysql)\b.*\b(drop|truncate)\s+(table|database)/i,
    { action: "ask", reason: "destructive SQL" },
  ],
  [
    /(^|\s)(cat|less|head|tail|cp|scp|curl)\s+.*(~\/\.ssh\/|\/\.aws\/credentials|\.env\b)/,
    { action: "deny", reason: "reads credentials" },
  ],
  [/\b(nc|ncat|socat)\b.*\s-e\s/, { action: "deny", reason: "reverse shell" }],
];

// ---------- classifier ----------
/** The most severe risk across every sub-command of `command`, or null when none matches. */
export function classifyCommand(command: string): Risk | null {
  // Checked on the whole line: `curl … | sh` spans two sub-commands once parsed.
  if (PIPE_INTO_SHELL.test(command) && REMOTE_FETCH.test(command)) return PIPE_REMOTE_SCRIPT;
  let worst: Risk | null = null;
  for (const subCommand of splitCommands(command)) {
    for (const [pattern, risk] of RISKS) {
      if (pattern.test(subCommand) && isMoreSevere(risk, worst)) worst = risk;
    }
  }
  return worst;
}

// ---------- helpers ----------
function splitCommands(command: string): string[] {
  const parsed = parseShell(command);
  if (!parsed.ok) return [command.trim()];
  return parsed.commands.map((c) => c.text);
}

/** The first match wins unless a later one escalates "ask" to "deny". */
function isMoreSevere(risk: Risk, worst: Risk | null): boolean {
  if (!worst) return true;
  return risk.action === "deny" && worst.action !== "deny";
}
