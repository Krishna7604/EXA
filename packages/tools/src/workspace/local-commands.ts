// Custom slash commands: markdown templates from the project's and user's config dirs, and
// their expansion ($ARGUMENTS, $1..$9, @file inlining, optional !`shell` substitution).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIRS, readMarkdownDefinitions } from "./config-markdown.ts";
import { parseFrontmatter } from "./frontmatter.ts";

// ---------- constants ----------
/** Splits arguments on whitespace, keeping "double quoted" runs together. */
const ARGUMENT = /"[^"]*"|\S+/g;
const POSITIONAL = /\$([1-9])/g;
const SHELL_SUBSTITUTION = /!`([^`]+)`/g;
const FILE_REFERENCE = /(^|\s)@([\w./-]+)/g;
/** Sentence punctuation stuck to the end of an @path isn't part of it. */
const TRAILING_PUNCTUATION = /[.,;:]+$/;
const MAX_INLINE_FILE_CHARS = 50_000;

// ---------- types ----------
export interface CommandDef {
  name: string;
  description: string;
  agent?: string;
  model?: string;
  template: string;
  path: string;
}

interface ExpandOptions {
  root: string;
  allowShell: boolean;
  runShell?: (c: string) => Promise<string>;
}

// ---------- local commands ----------
/** Custom slash commands: <root>/{.exa,.opencode,.claude}/commands/*.md then ~/.exa/commands/*.md. */
export async function loadLocalCommands(
  root: string,
  home: string = homedir(),
): Promise<CommandDef[]> {
  const files = await readMarkdownDefinitions([
    ...CONFIG_DIRS.map((d) => join(root, d, "commands")),
    join(home, ".exa", "commands"),
  ]);
  return files.map((f) => {
    const { data, body } = parseFrontmatter(f.text);
    return {
      name: f.name,
      description: data.description ?? "",
      agent: data.agent || undefined,
      model: data.model || undefined,
      template: body.trim(),
      path: f.path,
    };
  });
}

/**
 * Expand a command template: $ARGUMENTS, $1..$9, @path (file contents, inside root only),
 * and !`cmd` (shell output, run in the project root — only when `allowShell`).
 */
export async function expandCommand(
  cmd: CommandDef,
  args: string,
  opts: ExpandOptions,
): Promise<string> {
  const withArgs = substituteArguments(cmd.template, args);
  const withShell = await substituteShell(withArgs, opts);
  return inlineFiles(withShell, opts.root);
}

// ---------- helpers ----------
function substituteArguments(template: string, args: string): string {
  const argv = args.match(ARGUMENT)?.map((a) => a.replace(/^"|"$/g, "")) ?? [];
  return template
    .replace(/\$ARGUMENTS/g, args)
    .replace(POSITIONAL, (_m, n) => argv[Number(n) - 1] ?? "");
}

async function substituteShell(text: string, opts: ExpandOptions): Promise<string> {
  let t = text;
  for (const m of [...t.matchAll(SHELL_SUBSTITUTION)]) {
    const out =
      opts.allowShell && opts.runShell
        ? await opts.runShell(m[1])
        : `[shell substitution skipped: ${m[1]}]`;
    t = t.replace(m[0], out.trim());
  }
  return t;
}

/** Replace each @path that resolves inside `root` with the file's (truncated) contents. */
async function inlineFiles(text: string, root: string): Promise<string> {
  let t = text;
  const rootPrefix = `${resolve(root)}/`;
  for (const m of [...t.matchAll(FILE_REFERENCE)]) {
    const ref = m[2].replace(TRAILING_PUNCTUATION, "");
    const abs = resolve(root, ref);
    if (!abs.startsWith(rootPrefix)) continue;
    try {
      const content = await readFile(abs, "utf8");
      const block = `\n<file path="${ref}">\n${content.slice(0, MAX_INLINE_FILE_CHARS)}\n</file>\n`;
      t = t.replace(`@${ref}`, block);
    } catch {
      // unreadable or missing: leave the @path as written
    }
  }
  return t;
}
