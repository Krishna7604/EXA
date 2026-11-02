// Parse KEY=VALUE env files (for --env-file in local mode).

import { readFile } from "node:fs/promises";

// ---------- constants ----------
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

// ---------- env file ----------
/** KEY=VALUE env file (for --env-file in local mode). Never logged. */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const m = line.match(ENV_LINE);
    if (!m) continue;
    const value = unquote(m[2]);
    if (value) out[m[1]] = value;
  }
  return out;
}

// ---------- helpers ----------
function unquote(v: string): string {
  const isDoubleQuoted = v.startsWith('"') && v.endsWith('"');
  const isSingleQuoted = v.startsWith("'") && v.endsWith("'");
  return isDoubleQuoted || isSingleQuoted ? v.slice(1, -1) : v;
}
