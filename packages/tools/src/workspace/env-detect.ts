// Environment facts for the system prompt: workspace root (git root if any), platform,
// date and current git branch.

import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { EnvInfo } from "@exa/core";
import { runGit } from "./git-run.ts";

// ---------- constants ----------
/** Length of an ISO date (YYYY-MM-DD). */
const ISO_DATE_LENGTH = 10;

// ---------- env detection ----------
export async function findGitRoot(start: string): Promise<string | null> {
  let cur = resolve(start);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export async function detectEnv(
  cwd: string,
  host: "client" | "server" = "client",
): Promise<EnvInfo> {
  const gitRoot = await findGitRoot(cwd);
  const gitBranch = gitRoot ? await currentBranch(gitRoot) : undefined;
  return {
    root: gitRoot ?? resolve(cwd),
    cwd: resolve(cwd),
    platform: platform(),
    date: new Date().toISOString().slice(0, ISO_DATE_LENGTH),
    isGitRepo: !!gitRoot,
    gitBranch,
    host,
  };
}

// ---------- helpers ----------
async function currentBranch(gitRoot: string): Promise<string | undefined> {
  const r = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: gitRoot });
  return r.code === 0 ? r.out.trim() : undefined;
}
