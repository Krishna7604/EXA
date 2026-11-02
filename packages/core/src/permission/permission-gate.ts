// Per-session permission gate: engine decision → optional server authorizer → user approval,
// remembering "always" answers as session rules. Fails closed: authorizer errors become `ask`.

import {
  newId,
  type PermissionAction,
  type PermissionReply,
  type PermissionRequest,
  type PermissionRule,
} from "@exa/protocol";
import {
  PermissionDeniedError,
  type PermissionEngine,
  PermissionRejectedError,
  strictest,
} from "./permission-engine.ts";

// ---------- constants ----------
const APPROVAL_TITLE_MAX_CHARS = 300;

// ---------- types ----------
export interface PermissionAsk {
  permission: string;
  /** Resources to check, e.g. absolute paths or parsed shell commands. */
  patterns: string[];
  /** Alternative spellings per pattern (same index), e.g. root-relative paths. */
  aliases?: string[][];
  /** Patterns stored as session rules if the user answers "always". */
  always?: string[];
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalPort {
  request(req: PermissionRequest, signal?: AbortSignal): Promise<PermissionReply>;
}

/** Server-side checks for keys listed in the policy bundle's `serverChecked`. */
export interface AuthorizerPort {
  authorize(req: {
    sessionId: string;
    tool: string;
    permission: string;
    patterns: string[];
    input?: unknown;
  }): Promise<{ action: PermissionAction; reason?: string }>;
}

interface GateOptions {
  sessionId: string;
  authorizer?: AuthorizerPort;
  serverChecked?: Set<string>;
  onAlways?: (rules: PermissionRule[]) => void;
}

/** The tool call a check is for. */
interface CheckContext {
  tool: string;
  callId?: string;
  messageId?: string;
  input?: unknown;
  signal?: AbortSignal;
}

interface GateDecision {
  action: PermissionAction;
  denied?: { pattern: string; rule?: PermissionRule };
  /** Patterns that need the user's approval. */
  askPatterns: string[];
}

// ---------- permission gate ----------
/**
 * Per-session permission gate: engine + approvals + "always" memory + optional server authorizer.
 * Fails closed: authorizer errors become `ask`.
 */
export class PermissionGate {
  private sessionRules: PermissionRule[] = [];

  constructor(
    private engine: PermissionEngine,
    private readonly approvals: ApprovalPort,
    private readonly opts: GateOptions,
  ) {}

  get currentEngine(): PermissionEngine {
    return this.sessionRules.length ? this.engine.extend(this.sessionRules) : this.engine;
  }

  setEngine(engine: PermissionEngine): void {
    this.engine = engine;
  }

  decide(ask: PermissionAsk): GateDecision {
    const engine = this.currentEngine;
    let action: PermissionAction = "allow";
    const askPatterns: string[] = [];
    for (let i = 0; i < ask.patterns.length; i++) {
      const pattern = ask.patterns[i];
      const d = engine.evaluate(ask.permission, pattern, ask.aliases?.[i] ?? []);
      if (d.action === "deny")
        return { action: "deny", denied: { pattern, rule: d.rule }, askPatterns };
      if (d.action === "ask") askPatterns.push(pattern);
      action = strictest(action, d.action);
    }
    return { action, askPatterns };
  }

  /** Resolves when allowed; throws PermissionDeniedError or PermissionRejectedError otherwise. */
  async check(ask: PermissionAsk, ctx: CheckContext): Promise<void> {
    const local = this.decide(ask);
    if (local.action === "deny")
      throw new PermissionDeniedError(ask.permission, local.denied!.pattern, local.denied!.rule);
    const { action, askPatterns } = await this.applyServerCheck(ask, ctx, local);
    if (action === "allow") return;
    const reply = await this.requestApproval(ask, ctx, askPatterns);
    if (reply === "reject") throw new PermissionRejectedError(ask.permission);
    if (reply === "always") this.rememberAlways(ask);
  }

  /** For server-checked keys the authorizer can deny outright or turn an allow into an ask. */
  private async applyServerCheck(
    ask: PermissionAsk,
    ctx: CheckContext,
    local: GateDecision,
  ): Promise<GateDecision> {
    if (!this.opts.authorizer || !this.opts.serverChecked?.has(ask.permission)) return local;
    const remote = await this.authorize(this.opts.authorizer, ask, ctx);
    if (remote === "deny") throw new PermissionDeniedError(ask.permission, ask.patterns.join(", "));
    const askPatterns =
      remote === "ask" && local.action === "allow" ? ask.patterns : local.askPatterns;
    const action = strictest(local.action, remote) === "ask" ? "ask" : local.action;
    return { action, askPatterns };
  }

  private async authorize(
    authorizer: AuthorizerPort,
    ask: PermissionAsk,
    ctx: CheckContext,
  ): Promise<PermissionAction> {
    try {
      const res = await authorizer.authorize({
        sessionId: this.opts.sessionId,
        tool: ctx.tool,
        permission: ask.permission,
        patterns: ask.patterns,
        input: ctx.input,
      });
      return res.action;
    } catch {
      return "ask"; // fail closed: an unreachable authorizer means the user decides
    }
  }

  private requestApproval(
    ask: PermissionAsk,
    ctx: CheckContext,
    askPatterns: string[],
  ): Promise<PermissionReply> {
    const defaultTitle = `${ctx.tool}: ${ask.patterns.join(", ")}`.slice(
      0,
      APPROVAL_TITLE_MAX_CHARS,
    );
    return this.approvals.request(
      {
        id: newId(),
        sessionId: this.opts.sessionId,
        messageId: ctx.messageId,
        callId: ctx.callId,
        permission: ask.permission,
        patterns: askPatterns.length ? askPatterns : ask.patterns,
        tool: ctx.tool,
        title: ask.title ?? defaultTitle,
        metadata: ask.metadata,
        time: Date.now(),
      },
      ctx.signal,
    );
  }

  private rememberAlways(ask: PermissionAsk): void {
    const added = (ask.always ?? ask.patterns).map<PermissionRule>((pattern) => ({
      permission: ask.permission,
      pattern,
      action: "allow",
      scope: "session",
    }));
    this.sessionRules.push(...added);
    this.opts.onAlways?.(added);
  }
}
