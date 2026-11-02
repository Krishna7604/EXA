// Runs a git command non-interactively (no prompts, no optional locks, no CRLF or path
// quoting surprises) and returns its stdout and exit code.

// ---------- types ----------
export interface GitRunOptions {
  cwd: string;
  gitDir?: string;
  workTree?: string;
  input?: string;
}

// ---------- git ----------
export async function runGit(
  args: string[],
  opts: GitRunOptions,
): Promise<{ out: string; code: number }> {
  const full = [
    ...(opts.gitDir ? [`--git-dir=${opts.gitDir}`] : []),
    ...(opts.workTree ? [`--work-tree=${opts.workTree}`] : []),
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.quotepath=false",
    ...args,
  ];
  const p = Bun.spawn(["git", ...full], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out, code };
}
