// Chat renderer — message blocks with a right-side cost/token sidebar.
// Usage: responses carry real Bedrock totals; prompts show a ~estimate.
// Colors auto-disable when piped or NO_COLOR is set. Types live in ./types.ts.
import { formatCost } from "./observability/pricing.js";
import type { Item, MessageMeta } from "./types.js";

export type ChatRole = "user" | "agent";

export interface RendererOptions {
  width?: number;
  /** default: TTY && !NO_COLOR */
  color?: boolean;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

/** Big terminal logo — block letters, ~30 cols. Tagline below keeps a literal "exa". */
export const EXA_LOGO: string[] = [
  " ███████╗ ██╗  ██╗ █████╗ ",
  " ██╔════╝ ╚██╗██╔╝██╔══██╗",
  " █████╗    ╚███╔╝ ███████║",
  " ██╔══╝    ██╔██╗ ██╔══██║",
  " ███████╗ ██╔╝ ██╗██║  ██║",
  " ╚══════╝ ╚═╝  ╚═╝╚═╝  ╚═╝",
];

export class ConsoleRenderer {
  constructor(private readonly opts: RendererOptions = {}) {}

  private get width(): number {
    return Math.max(40, this.opts.width ?? process.stdout.columns ?? 80);
  }

  private get color(): boolean {
    return this.opts.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR);
  }

  private paint(code: string, s: string): string {
    return this.color ? `${code}${s}${RESET}` : s;
  }

  private ruler(): string {
    return this.paint(DIM, "─".repeat(this.width));
  }

  private rightPad(left: string, right: string): string {
    const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
    const gap = this.width - plain(left).length - plain(right).length;
    if (gap < 1) return `${left} ${right}`;
    return `${left}${" ".repeat(gap)}${right}`;
  }

  private fmtTokens(n: number): string {
    return n.toLocaleString("en-US");
  }

  private fmtMs(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }

  private metaLine(meta: MessageMeta | undefined, role: ChatRole): string {
    const bits: string[] = [];
    if (role === "agent") {
      if (meta?.model) bits.push(meta.model);
      if (meta?.inputTokens !== undefined || meta?.outputTokens !== undefined) {
        bits.push(`${this.fmtTokens(meta.inputTokens ?? 0)} in · ${this.fmtTokens(meta.outputTokens ?? 0)} out`);
      }
      bits.push(formatCost(meta?.costUsd));
      if (meta?.ms !== undefined) bits.push(this.fmtMs(meta.ms));
    } else if (meta?.estimatedTokens !== undefined) {
      bits.push(`~${this.fmtTokens(meta.estimatedTokens)} tok`);
    }
    if (meta?.time) bits.push(meta.time);
    return this.paint(DIM, bits.join(" · "));
  }

  /** exa brand mark (colored when allowed). */
  brand(): string {
    return this.paint(BOLD + GREEN, "exa");
  }

  /** Welcome banner for the REPL. */
  welcome(version: string): void {
    for (const line of EXA_LOGO) console.log(this.paint(BOLD + GREEN, line));
    console.log(`${this.brand()} ${this.paint(DIM, `— your local AI harness · ${version}`)}`);
    console.log(this.paint(DIM, "chat freely · Tab completes /commands · /exit to quit"));
    console.log(this.ruler());
  }

  /** Interactive input prompt, e.g. `exa › ` with a dim session tag. */
  chatPrompt(sessionId: string): string {
    const tag = this.paint(DIM, `[${sessionId.slice(0, 13)}]`);
    return `${this.brand()} ${tag} ${this.paint(BOLD + CYAN, "›")} `;
  }

  /** One chat block: header (who left, cost/tokens right), body, ruler. */
  message(role: ChatRole, text: string, meta?: MessageMeta): void {
    const who = role === "user" ? "You" : "exa";
    const header = this.rightPad(
      this.paint(BOLD + (role === "user" ? CYAN : GREEN), who),
      this.metaLine(meta, role),
    );
    console.log(this.ruler());
    console.log(header);
    console.log(this.ruler());
    console.log(text);
  }

  info(text: string): void {
    console.log(this.paint(DIM, text));
  }

  error(text: string): void {
    console.log(this.paint(RED, text));
  }

  banner(text: string): void {
    console.log(this.ruler());
    console.log(this.paint(BOLD, text));
    console.log(this.ruler());
  }

  /** Back-compat entry — plain lines for tool calls, blocks for messages. */
  render(item: Item): void {
    if (item.type === "message") {
      const role: ChatRole = item.role === "user" ? "user" : "agent";
      this.message(role, item.text);
    } else if (item.type === "function_call") {
      console.log(this.paint(DIM, `[tool:${item.name}] ${JSON.stringify(item.args)}`));
    } else {
      console.log(this.paint(DIM, `[tool:${item.name} =>] ${JSON.stringify(item.output)?.slice(0, 500)}`));
    }
  }
}

export const defaultRenderer = new ConsoleRenderer();

export function render(item: Item): void {
  defaultRenderer.render(item);
}
