// Local shell runner for the bash tool: spawns the command in its own process group,
// captures combined output (bounded), and kills the whole group on timeout or abort.

import { type ChildProcess, spawn } from "node:child_process";
import { scrubbedEnv } from "../../helpers/shell-env.helper.ts";

// ---------- constants ----------
const MAX_CAPTURE = 4 * 1024 * 1024;
const FALLBACK_SHELL = "/bin/bash";
const SUPPORTED_SHELL = /(bash|zsh)$/;
/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000;
const NON_INTERACTIVE_ENV = {
  EXA_AGENT: "1",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

// ---------- types ----------
export interface ShellRunner {
  run(
    cmd: string,
    opts: {
      cwd: string;
      timeoutMs: number;
      signal: AbortSignal;
      onOutput?: (chunk: string) => void;
    },
  ): Promise<{
    output: string;
    exitCode: number | null;
    timedOut: boolean;
  }>;
}

// ---------- local shell ----------
export const localShell: ShellRunner = {
  run(cmd, opts) {
    return new Promise((resolve, reject) => {
      const child = spawn(userShell(), ["-c", cmd], {
        cwd: opts.cwd,
        env: { ...scrubbedEnv(), ...NON_INTERACTIVE_ENV },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const capture = captureOutput(child, opts.onOutput);
      let timedOut = false;
      const kill = () => killGroup(child);
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
      opts.signal.addEventListener("abort", kill, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal.removeEventListener("abort", kill);
      };
      child.on("error", (e) => {
        cleanup();
        reject(e);
      });
      child.on("close", (code) => {
        cleanup();
        resolve({ output: capture.output, exitCode: code, timedOut });
      });
    });
  },
};

// ---------- helpers ----------
/** The user's bash/zsh if that's what $SHELL is, otherwise /bin/bash. */
function userShell(): string {
  const shell = process.env.SHELL;
  return shell && SUPPORTED_SHELL.test(shell) ? shell : FALLBACK_SHELL;
}

/** Accumulate stdout+stderr up to MAX_CAPTURE bytes while streaming every chunk live. */
function captureOutput(
  child: ChildProcess,
  onOutput: ((chunk: string) => void) | undefined,
): { output: string } {
  const capture = { output: "" };
  let size = 0;
  const onData = (b: Buffer) => {
    const s = b.toString("utf8");
    if (size < MAX_CAPTURE) {
      capture.output += s;
      size += b.length;
    }
    onOutput?.(s);
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  return capture;
}

/** SIGTERM the process group, then SIGKILL it after a grace period. */
function killGroup(child: ChildProcess): void {
  signalGroup(child, "SIGTERM");
  setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS).unref?.();
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // group already exited
  }
}
