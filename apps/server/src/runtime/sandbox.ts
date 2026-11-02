// Server-side workspaces for light clients. Files live in a per-session directory; shell
// commands (only when EXA_SANDBOX_SHELL=docker) run inside a long-lived, network-less,
// resource-capped container per session that mounts only that directory.

import { mkdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ShellRunner } from "@exa/tools";

// ---------- constants ----------
const ID_SHAPE = /^[0-9a-f-]{36}$/;
const CONTAINER_WORKDIR = "/workspace";
/** uid/gid used when the host can't tell us the workspace owner ("nobody"). */
const NOBODY_ID = 65534;
const START_ERROR_PREVIEW_CHARS = 300;
const RESOURCE_LIMITS = ["--memory", "1g", "--cpus", "1", "--pids-limit", "256"];
const HARDENING = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only"];

// ---------- types ----------
interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?: (s: string) => void;
}

// ---------- workspaces ----------
export class Workspaces {
  constructor(private readonly root: string) {}

  dir(tenantId: string, sessionId: string): string {
    if (!ID_SHAPE.test(tenantId) || !ID_SHAPE.test(sessionId)) throw new Error("bad workspace id");
    return join(this.root, tenantId, sessionId);
  }

  async ensure(tenantId: string, sessionId: string): Promise<string> {
    const dir = this.dir(tenantId, sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async remove(tenantId: string, sessionId: string): Promise<void> {
    await rm(this.dir(tenantId, sessionId), { recursive: true, force: true });
  }
}

// ---------- docker sandbox ----------
export class DockerSandbox implements ShellRunner {
  private container: string | null = null;
  private starting: Promise<string> | null = null;

  constructor(
    private readonly hostDir: string,
    private readonly image: string,
    private readonly name: string,
  ) {}

  async run(cmd: string, opts: RunOptions) {
    const id = await this.start();
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, opts.timeoutMs);
    const onAbort = () => ac.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    try {
      // `timeout` inside the container guarantees the process dies even if the client is killed
      const secs = String(Math.max(1, Math.ceil(opts.timeoutMs / 1000)));
      const cwd = this.containerCwd(opts.cwd);
      const proc = Bun.spawn(
        ["docker", "exec", "-w", cwd, id, "timeout", "-s", "KILL", secs, "sh", "-c", cmd],
        { stdout: "pipe", stderr: "pipe", signal: ac.signal },
      );
      const [out, err, code] = await Promise.all([
        readStream(proc.stdout, opts.onOutput),
        readStream(proc.stderr, opts.onOutput),
        proc.exited,
      ]);
      return { output: out + err, exitCode: timedOut ? null : code, timedOut };
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
    }
  }

  async stop(): Promise<void> {
    const id = this.container;
    this.container = null;
    this.starting = null;
    // The container runs with --rm; a failed forced removal means it is already gone.
    if (id) await exec(["docker", "rm", "-f", id]).catch(() => {});
  }

  private start(): Promise<string> {
    if (this.container) return Promise.resolve(this.container);
    if (!this.starting) this.starting = this.launch();
    return this.starting;
  }

  private async launch(): Promise<string> {
    const result = await exec(this.dockerRunArgs());
    if (result.code !== 0) {
      const preview = result.out.slice(0, START_ERROR_PREVIEW_CHARS);
      throw new Error(`sandbox failed to start: ${preview}`);
    }
    this.container = result.out.trim().split("\n").pop()!;
    return this.container;
  }

  private dockerRunArgs(): string[] {
    const uid = process.getuid?.() ?? NOBODY_ID;
    const gid = process.getgid?.() ?? NOBODY_ID;
    return [
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      this.name,
      "--network",
      "none",
      ...RESOURCE_LIMITS,
      ...HARDENING,
      // run as the workspace owner, never root
      "--user",
      `${uid}:${gid}`,
      "-e",
      "HOME=/tmp",
      "--tmpfs",
      "/tmp:rw,size=256m",
      "-v",
      `${this.hostDir}:${CONTAINER_WORKDIR}:rw`,
      "-w",
      CONTAINER_WORKDIR,
      this.image,
      "sleep",
      "infinity",
    ];
  }

  /** Maps a host cwd inside the workspace to its container path; anything else → the root. */
  private containerCwd(hostCwd: string): string {
    const rel = relative(this.hostDir, hostCwd);
    if (!rel || rel.startsWith("..")) return CONTAINER_WORKDIR;
    return `${CONTAINER_WORKDIR}/${rel}`;
  }
}

// ---------- helpers ----------
async function exec(args: string[], signal?: AbortSignal): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: out + err, code };
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onOutput?: (text: string) => void,
): Promise<string> {
  let acc = "";
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    acc += text;
    onOutput?.(text);
  }
  return acc;
}
