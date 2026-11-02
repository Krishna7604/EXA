// Terminal renderer for the event stream + interactive approvals/questions.

import type { Interface as RlInterface } from "node:readline/promises";
import type {
  ExaEvent,
  MessageInfo,
  Part,
  PermissionReply,
  PermissionRequest,
  ToolPart,
} from "@exa/protocol";
import { color } from "./color.ts";

// ---------- constants ----------
const LOGO = [
  "  ███████╗██╗  ██╗ █████╗ ",
  "  ██╔════╝╚██╗██╔╝██╔══██╗",
  "  █████╗   ╚███╔╝ ███████║",
  "  ██╔══╝   ██╔██╗ ██╔══██║",
  "  ███████╗██╔╝ ██╗██║  ██║",
  "  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝",
];

/** Tool input fields tried in order for a one-line label. */
const TOOL_LABEL_KEYS = ["description", "command", "filePath", "pattern", "url", "path", "name"];
const LABEL_PREVIEW_CHARS = 100;
const ERROR_PREVIEW_CHARS = 160;
/** Show a tool's duration only when it took longer than this. */
const SLOW_TOOL_MS = 1500;
const BASH_TAIL_LINES = 6;
const MAX_APPROVAL_PATTERNS = 8;
const TODO_MARKS: Record<string, string> = {
  pending: "☐",
  in_progress: color.yellow("◐"),
  completed: color.green("☑"),
  cancelled: color.gray("☒"),
};

// ---------- types ----------
export interface BannerInfo {
  mode: string;
  model: string;
  cwd: string;
  storage: string;
  server?: string;
  tenant?: string;
  agent: string;
}

interface TurnTotals {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
  model: string;
}

type Todo = { content: string; status: string };
type Question = { question: string; options: string[]; multiple?: boolean };
type ToolMetadata = Record<string, unknown> & {
  exit?: number;
  additions?: number;
  deletions?: number;
  matches?: number;
  count?: number;
  shown?: number;
};

// ---------- ui ----------
export class Ui {
  rootSessionId = "";
  showThinking = false;
  private openText: string | null = null;
  private atLineStart = true;
  private turnStart = 0;
  private turn: TurnTotals = emptyTurn();
  private printedTools = new Set<string>();
  private thinkingShown = new Set<string>();

  constructor(private readonly out: NodeJS.WriteStream = process.stdout) {}

  write(s: string): void {
    if (!s) return;
    this.out.write(s);
    this.atLineStart = s.endsWith("\n");
  }

  line(s = ""): void {
    if (!this.atLineStart) this.write("\n");
    this.write(`${s}\n`);
  }

  banner(info: BannerInfo): void {
    if (this.out.isTTY) for (const l of LOGO) this.line(color.cyan(l));
    const where = info.server ? `${info.tenant}@${info.server}` : "local mode";
    this.line();
    this.line(`  ${color.bold("exa")} ${color.gray("v2")}  ${color.gray("·")} ${where}`);
    this.line(
      `  ${color.gray("model")} ${info.model}  ${color.gray("agent")} ${info.agent}  ${color.gray("mode")} ${info.mode}  ${color.gray("storage")} ${info.storage}`,
    );
    this.line(`  ${color.gray("cwd")} ${info.cwd}`);
    this.line(color.gray("  /help for commands · Ctrl+C aborts a turn · Ctrl+D exits"));
    this.line();
  }

  beginTurn(): void {
    this.turnStart = Date.now();
    this.turn = emptyTurn();
    this.openText = null;
  }

  endTurn(): void {
    if (!this.turnStart) return;
    const seconds = ((Date.now() - this.turnStart) / 1000).toFixed(1);
    const t = this.turn;
    const cached = t.cacheRead ? ` (+${fmtTokens(t.cacheRead)} cached)` : "";
    this.line(
      color.gray(
        `  ── ${t.model || "model"} · ${fmtTokens(t.input)} in${cached} / ${fmtTokens(t.output)} out · ${fmtCost(t.cost)} · ${seconds}s`,
      ),
    );
    this.turnStart = 0;
  }

  /** Render one loop event. Events from sub-agent sessions only show their tool calls. */
  handle(e: ExaEvent): void {
    const isSub = this.isSubSession(e);
    if (e.type === "message.part.updated") {
      this.onPartUpdated((e.data as { part: Part }).part, isSub);
      return;
    }
    if (isSub) return;
    switch (e.type) {
      case "message.part.delta":
        this.onDelta(e.data as { partId: string; delta: string });
        break;
      case "message.updated":
        this.onMessageUpdated((e.data as { info: MessageInfo }).info);
        break;
      case "session.status":
        this.onStatus(e.data as { status: string; detail?: string });
        break;
      case "session.compacted":
        this.line(color.gray("  ⇢ context compacted"));
        break;
      case "todo.updated":
        this.renderTodos((e.data as { todos: Todo[] }).todos);
        break;
      case "session.updated":
        this.setTitle((e.data as { info: { title?: string } }).info.title);
        break;
    }
  }

  async approval(
    rl: RlInterface,
    req: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionReply | null> {
    this.line();
    this.line(
      `  ${color.yellow("?")} ${color.bold("Permission")} ${color.gray(req.permission)}  ${req.title}`,
    );
    if (req.patterns.length > 1 || (req.patterns[0] && !req.title.includes(req.patterns[0]))) {
      for (const p of req.patterns.slice(0, MAX_APPROVAL_PATTERNS))
        this.line(color.gray(`      ${p}`));
    }
    const prompt = `    ${color.bold("[y]")}es once · ${color.bold("[a]")}lways this session · ${color.bold("[n]")}o › `;
    for (;;) {
      let ans: string;
      try {
        ans = (await rl.question(prompt, { signal })).trim().toLowerCase();
      } catch {
        return null; // answered elsewhere / aborted
      }
      const reply = parseApprovalAnswer(ans);
      if (reply) return reply;
    }
  }

  async question(rl: RlInterface, qs: Question[], signal: AbortSignal): Promise<string[][]> {
    const answers: string[][] = [];
    for (const q of qs) {
      this.line();
      this.line(`  ${color.cyan("?")} ${color.bold(q.question)}`);
      for (const [i, o] of q.options.entries()) this.line(`    ${i + 1}. ${o}`);
      const hint = q.multiple ? "choose (e.g. 1,3)" : "choose";
      const raw = (await rl.question(`    ${hint} or type an answer › `, { signal })).trim();
      const picks = parsePicks(raw, q.options);
      answers.push(q.multiple ? picks : picks.slice(0, 1));
    }
    return answers;
  }

  // ---------- event handlers ----------
  private isSubSession(e: ExaEvent): boolean {
    return !!this.rootSessionId && e.sessionId !== this.rootSessionId;
  }

  private onDelta(d: { partId: string; delta: string }): void {
    if (this.thinkingShown.has(d.partId)) {
      if (this.showThinking) this.write(color.dim(d.delta));
      return;
    }
    let delta = d.delta;
    if (this.openText !== d.partId) {
      // swallow leading whitespace so empty preambles before tool calls print nothing
      delta = delta.replace(/^\s+/, "");
      if (!delta) return;
      this.line();
      this.openText = d.partId;
    }
    this.write(delta);
  }

  private onPartUpdated(p: Part, isSub: boolean): void {
    if (p.type === "tool") {
      this.renderTool(p, isSub);
      return;
    }
    if (isSub) return;
    if (p.type === "reasoning" && !this.thinkingShown.has(p.id)) {
      this.thinkingShown.add(p.id);
      this.line(color.gray("  · thinking…"));
      this.openText = null;
    }
    if (p.type === "step-finish") {
      this.turn.input += p.tokens.input;
      this.turn.output += p.tokens.output;
      this.turn.cacheRead += p.tokens.cacheRead;
      this.turn.cost += p.cost;
      if (p.modelUsed) this.turn.model = p.modelUsed;
    }
    if (p.type === "patch")
      this.line(color.gray(`  ↺ ${p.files.length} file(s) changed — /undo to revert`));
  }

  private onMessageUpdated(info: MessageInfo): void {
    if (info.error) this.line(color.red(`  ✗ ${info.error.message}`));
  }

  private onStatus(d: { status: string; detail?: string }): void {
    if (d.status === "retry") this.line(color.yellow(`  ↻ retrying: ${d.detail ?? ""}`));
  }

  private renderTodos(todos: Todo[]): void {
    this.line(color.gray("  todo"));
    for (const t of todos) {
      const content = t.status === "completed" ? color.gray(t.content) : t.content;
      this.line(`   ${TODO_MARKS[t.status] ?? "·"} ${content}`);
    }
  }

  private setTitle(title: string | undefined): void {
    if (title && process.stdout.isTTY) this.write(`\x1b]0;exa · ${title}\x07`);
  }

  // ---------- tool rendering ----------
  private renderTool(p: ToolPart, isSub: boolean): void {
    const st = p.state;
    const indent = isSub ? "    ↳ " : "  ";
    const input = (st.input ?? {}) as Record<string, unknown>;
    if (st.status === "running") {
      if (p.tool === "task") this.renderTaskStart(indent, input);
      return;
    }
    if (st.status !== "completed" && st.status !== "error") return;
    if (this.printedTools.has(p.id)) return;
    this.printedTools.add(p.id);
    this.openText = null;
    const label = toolLabel(input);
    if (st.status === "error") {
      const error = color.red(st.error.split("\n")[0].slice(0, ERROR_PREVIEW_CHARS));
      this.line(
        `${indent}${color.red("✗")} ${p.tool} ${color.gray(label.slice(0, LABEL_PREVIEW_CHARS))} ${error}`,
      );
      return;
    }
    this.renderToolDone(p, indent, label);
  }

  private renderTaskStart(indent: string, input: Record<string, unknown>): void {
    const agent = color.bold(String(input.subagent_type ?? ""));
    this.line(`${indent}${color.magenta("◆")} task ${agent}: ${input.description ?? ""}`);
  }

  private renderToolDone(p: ToolPart, indent: string, label: string): void {
    const st = p.state;
    if (st.status !== "completed") return;
    const md = st.metadata as ToolMetadata;
    const ms = st.time.end - st.time.start;
    const duration = ms > SLOW_TOOL_MS ? color.gray(` ${(ms / 1000).toFixed(1)}s`) : "";
    const shown = p.tool === "bash" || p.tool === "task" ? label : st.title || label;
    this.line(
      `${indent}${color.green("✓")} ${p.tool} ${shown.slice(0, LABEL_PREVIEW_CHARS)}${toolExtra(p.tool, md)}${duration}`,
    );
    if (p.tool === "bash" && md.exit !== 0) {
      const tail = st.output.split("\n").slice(-BASH_TAIL_LINES).join("\n");
      this.line(color.gray(tail.replace(/^/gm, `${indent}  │ `)));
    }
  }
}

// ---------- helpers ----------
function emptyTurn(): TurnTotals {
  return { input: 0, output: 0, cacheRead: 0, cost: 0, model: "" };
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const digits = n >= 10_000 ? 0 : 1;
  return `${(n / 1000).toFixed(digits)}k`;
}

function fmtCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** First present (non-null) label field, like a chain of `??`. */
function toolLabel(input: Record<string, unknown>): string {
  const key = TOOL_LABEL_KEYS.find((k) => input[k] !== undefined && input[k] !== null);
  return String(key ? input[key] : "");
}

/** Per-tool summary suffix (exit code, +/- lines, match counts, ...). */
function toolExtra(tool: string, md: ToolMetadata): string {
  let extra = "";
  if (tool === "bash") extra = md.exit === 0 ? "" : color.red(` exit ${md.exit ?? "?"}`);
  if ((tool === "edit" || tool === "write") && (md.additions || md.deletions))
    extra = ` ${color.green(`+${md.additions ?? 0}`)} ${color.red(`-${md.deletions ?? 0}`)}`;
  if (tool === "grep") extra = color.gray(` ${md.matches ?? 0} matches`);
  if (tool === "glob") extra = color.gray(` ${md.count ?? 0} files`);
  if (tool === "read") extra = color.gray(` ${md.shown ?? ""} lines`);
  return extra;
}

/** Empty input means "yes"; unknown input returns null so the prompt repeats. */
function parseApprovalAnswer(ans: string): PermissionReply | null {
  if (ans === "y" || ans === "yes" || ans === "") return "once";
  if (ans === "a" || ans === "always") return "always";
  if (ans === "n" || ans === "no") return "reject";
  return null;
}

/** Comma-separated answers; numbers pick an option, anything else is a free-text answer. */
function parsePicks(raw: string, options: string[]): string[] {
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (/^\d+$/.test(x) && options[Number(x) - 1] ? options[Number(x) - 1] : x));
}
