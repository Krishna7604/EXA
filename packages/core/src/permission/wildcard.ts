// Permission patterns: `*` = any run of characters (including `/`), `?` = exactly one,
// everything else literal. `~/` and `$HOME/` at the start expand to the home directory.

import { homedir } from "node:os";

// ---------- constants ----------
/** Compiled patterns are cached; past this size the cache is simply cleared. */
const MAX_CACHED_PATTERNS = 5000;
const REGEX_SPECIAL_CHARS = /[.+^${}()|[\]\\]/g;

const compiledPatterns = new Map<string, RegExp>();

// ---------- wildcard ----------
export function expandHome(pattern: string, home: string = homedir()): string {
  if (pattern === "~") return home;
  if (pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern.startsWith("$HOME/")) return home + pattern.slice(5);
  return pattern;
}

export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  return compile(pattern).test(value);
}

// ---------- helpers ----------
function compile(pattern: string): RegExp {
  const cached = compiledPatterns.get(pattern);
  if (cached) return cached;
  let src = "^";
  for (const ch of expandHome(pattern)) {
    if (ch === "*") src += "[\\s\\S]*";
    else if (ch === "?") src += "[\\s\\S]";
    else src += ch.replace(REGEX_SPECIAL_CHARS, "\\$&");
  }
  const re = new RegExp(`${src}$`);
  if (compiledPatterns.size > MAX_CACHED_PATTERNS) compiledPatterns.clear();
  compiledPatterns.set(pattern, re);
  return re;
}
