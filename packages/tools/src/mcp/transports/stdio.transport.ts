// MCP over stdio: spawns the server as a child process and exchanges newline-delimited
// JSON-RPC on its stdin/stdout. A dying server rejects every pending request.

import { type ChildProcess, spawn } from "node:child_process";
import { scrubbedEnv } from "../../helpers/shell-env.helper.ts";
import type { McpServerConfig } from "../mcp.config.ts";
import { type JsonRpcMessage, rpcError, Transport } from "./base.transport.ts";

// ---------- constants ----------
/** How much recent stderr to keep for crash messages. */
const STDERR_TAIL_CHARS = 4000;
const STDERR_TAIL_LINES = 3;

// ---------- types ----------
type LocalConfig = Extract<McpServerConfig, { type: "local" }>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------- stdio transport ----------
export class StdioTransport extends Transport {
  private readonly pending = new Map<number | string, Pending>();
  private readonly proc: ChildProcess;
  private buf = "";
  private id = 0;
  private stderr = "";
  private exited: string | null = null;

  constructor(cfg: LocalConfig, root: string) {
    super();
    const [cmd, ...args] = cfg.command;
    this.proc = spawn(cmd, args, {
      cwd: cfg.cwd ?? root,
      env: { ...scrubbedEnv(), ...cfg.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (d: string) => this.onData(d));
    this.proc.stderr!.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    this.proc.on("exit", (code, sig) => this.fail(sig ? `signal ${sig}` : `code ${code}`));
    this.proc.on("error", (e) => this.fail(e.message));
  }

  send(msg: Record<string, unknown>, expectResponse: boolean, timeoutMs: number): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(`MCP server not running (${this.exited})`));
    if (!expectResponse) {
      this.write({ jsonrpc: "2.0", ...msg });
      return Promise.resolve(undefined);
    }
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${String(msg.method)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, ...msg });
    });
  }

  async close(): Promise<void> {
    try {
      this.proc.stdin?.end();
      this.proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

  private write(msg: Record<string, unknown>): void {
    this.proc.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  /** Reject every in-flight request once the process is gone. */
  private fail(why: string): void {
    this.exited = why;
    const stderrTail = this.stderr.trim().split("\n").slice(-STDERR_TAIL_LINES).join(" ");
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server exited (${why}). ${stderrTail}`));
    }
    this.pending.clear();
  }

  private onData(d: string): void {
    this.buf += d;
    for (let nl = this.buf.indexOf("\n"); nl !== -1; nl = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      const msg = parseMessage(line);
      if (msg !== undefined) this.onMessage(msg);
    }
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (msg.id === undefined) return;
    if (msg.result !== undefined || msg.error !== undefined) this.settle(msg);
    else if (msg.method) this.answerServerRequest(msg);
  }

  private settle(msg: JsonRpcMessage): void {
    const p = this.pending.get(msg.id!);
    if (!p) return;
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.error) p.reject(rpcError(msg.error));
    else p.resolve(msg.result);
  }

  /** Server → client request (e.g. ping, roots/list): answer minimally. */
  private answerServerRequest(msg: JsonRpcMessage): void {
    const result = msg.method === "roots/list" ? { roots: [] } : {};
    this.write({ jsonrpc: "2.0", id: msg.id, result });
  }
}

// ---------- helpers ----------
function parseMessage(line: string): JsonRpcMessage | undefined {
  try {
    return JSON.parse(line) as JsonRpcMessage;
  } catch {
    return undefined; // servers sometimes log to stdout
  }
}
