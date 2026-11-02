// Permission asks for a bash command. Each PARSED subcommand is its own pattern;
// redirection targets need `edit`; path-like arguments of file commands that point outside
// the root need `external_directory`. Unparseable commands must be allowed verbatim.

import {
  commandPrefix,
  type ParsedCommand,
  type PermissionAsk,
  parseShell,
  type ToolContext,
} from "@exa/core";
import { pathAsks, type ResolvedPath, resolvePath } from "../../helpers/paths.helper.ts";

// ---------- constants ----------
const MAX_TITLE_CHARS = 200;
/** Redirect targets that never need an `edit` permission. */
const HARMLESS_REDIRECTS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
/** Arguments with these characters are expanded by the shell, so we can't check them. */
const SHELL_EXPANSION = /[$`*?]/;

/** Commands whose plain arguments are file paths worth confining. */
const PATH_ARG_COMMANDS = new Set([
  "rm",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "rmdir",
  "chmod",
  "chown",
  "ln",
  "cat",
  "cd",
  "tee",
  "truncate",
  "dd",
  "install",
  "rsync",
  "scp",
  "tar",
  "unzip",
  "zip",
]);

// ---------- types ----------
type Location = Pick<ToolContext, "root" | "cwd">;

// ---------- bash asks ----------
export function bashAsks(
  command: string,
  ctx: Pick<ToolContext, "root" | "cwd">,
  workdir?: string,
): PermissionAsk[] {
  const asks: PermissionAsk[] = [];
  const cwdCtx = workdir ? { root: ctx.root, cwd: resolvePath(ctx, workdir).abs } : ctx;
  if (workdir) asks.push(...externalOnly(resolvePath(ctx, workdir)));
  const parsed = parseShell(command);
  if (!parsed.ok || !parsed.commands.length) {
    asks.push(rawCommandAsk(command));
    return asks;
  }
  const patterns: string[] = [];
  const always: string[] = [];
  for (const c of parsed.commands) {
    patterns.push(c.text);
    const prefix = commandPrefix(c);
    always.push(prefix, `${prefix} *`);
    asks.push(...redirectAsks(c, cwdCtx), ...pathArgumentAsks(c, cwdCtx));
  }
  asks.unshift({
    permission: "bash",
    patterns,
    always: [...new Set(always)],
    title: command.slice(0, MAX_TITLE_CHARS),
  });
  return asks;
}

// ---------- helpers ----------
/** Can't reason about it → the raw string must be explicitly allowed (or asked). */
function rawCommandAsk(command: string): PermissionAsk {
  return {
    permission: "bash",
    patterns: [command.trim()],
    always: [],
    title: command.slice(0, MAX_TITLE_CHARS),
  };
}

function redirectAsks(c: ParsedCommand, cwdCtx: Location): PermissionAsk[] {
  const asks: PermissionAsk[] = [];
  for (const w of c.writes) {
    if (HARMLESS_REDIRECTS.has(w)) continue;
    asks.push(...pathAsks("edit", resolvePath(cwdCtx, w), `write ${w} (redirect)`));
  }
  return asks;
}

function pathArgumentAsks(c: ParsedCommand, cwdCtx: Location): PermissionAsk[] {
  if (!PATH_ARG_COMMANDS.has(c.words[0])) return [];
  const asks: PermissionAsk[] = [];
  for (const arg of c.words.slice(1)) {
    if (arg.startsWith("-") || SHELL_EXPANSION.test(arg)) continue;
    asks.push(...externalOnly(resolvePath(cwdCtx, arg)));
  }
  return asks;
}

/** Just the `external_directory` ask for a path outside the root (none when inside). */
function externalOnly(r: ResolvedPath): PermissionAsk[] {
  if (r.inside) return [];
  return pathAsks("external_directory", r).filter((a) => a.permission === "external_directory");
}
