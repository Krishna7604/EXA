// THE agent loop. Hosted unchanged by the heavy client (client loop) and the server (server loop).
//
//   prompt → [compact?] → model stream → tool calls → permission gate → execute → results → repeat
//   until the model stops calling tools, the step/cost cap is hit, the user rejects, or abort.
//
// This class is the public API and per-session bookkeeping (busy/abort, permission gates); the
// step machinery lives in step-runner.ts and the modules it uses.

import type { MessageWithParts, SessionInfo } from "@exa/protocol";
import type { LoopDeps, PromptInput, PromptResult } from "../models/loop.model.ts";
import { compactHistory } from "./compaction.ts";
import type { LoopConfig } from "./loop.config.ts";
import { commitPendingRevert, markReverted, undoRevert } from "./revert.ts";
import { type DeferredTools, LoopRuntime } from "./runtime.ts";
import { SessionGates } from "./session-gates.ts";
import { runSteps } from "./step-runner.ts";
import { createTaskTool } from "./task.tool.ts";
import { generateTitle } from "./title.ts";
import { createToolSearchTool } from "./tool-search.tool.ts";
import { appendUserMessage } from "./user-message.ts";

// ---------- agent loop ----------
export class AgentLoop {
  private readonly rt: LoopRuntime;
  private readonly gates: SessionGates;
  private readonly running = new Map<string, AbortController>();
  readonly cfg: LoopConfig;
  /** Per session: deferred tools currently available, and the ones the model has loaded. */
  readonly deferred: Map<string, DeferredTools>;

  constructor(readonly deps: LoopDeps) {
    this.rt = new LoopRuntime(deps);
    this.gates = new SessionGates(deps);
    this.cfg = this.rt.cfg;
    this.deferred = this.rt.deferred;
    if (!deps.tools.get("task")) deps.tools.register(createTaskTool(this));
    if (!deps.tools.get("tool_search")) deps.tools.register(createToolSearchTool(this));
  }

  async prompt(input: PromptInput): Promise<PromptResult> {
    const session = await this.rt.requireSession(input.sessionId);
    if (this.running.has(session.id)) throw new SessionBusyError(session.id);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) ac.abort();
    this.running.set(session.id, ac);
    this.rt.emit("session.status", session.id, { status: "busy" });
    try {
      return await this.runPrompt(session, input, ac.signal);
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      this.running.delete(session.id);
      this.rt.emit("session.status", session.id, { status: "idle" });
      this.rt.emit("session.idle", session.id, {});
    }
  }

  isBusy(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  abort(sessionId: string): boolean {
    const ac = this.running.get(sessionId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  /** Summarize everything before the latest user turn; that turn and later stay verbatim. */
  async compact(
    session: SessionInfo,
    history: MessageWithParts[],
    signal: AbortSignal,
    auto: boolean,
  ): Promise<MessageWithParts[]> {
    return compactHistory(this.rt, session, history, signal, auto);
  }

  /** Manual compaction (/compact). */
  async compactSession(
    sessionId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<boolean> {
    const session = await this.rt.requireSession(sessionId);
    const history = await this.deps.store.messages(sessionId);
    const after = await this.compact(session, history, signal, false);
    return after.length !== history.length;
  }

  /** Mark a message (or part) reverted and restore its files when the host has snapshots. */
  async revert(sessionId: string, messageId: string, partId?: string): Promise<void> {
    await markReverted(this.rt, sessionId, { messageId, partId });
  }

  async unrevert(sessionId: string): Promise<void> {
    await undoRevert(this.rt, sessionId);
  }

  /** Drop cached per-session state ("always" approvals). */
  forget(sessionId: string): void {
    this.gates.forget(sessionId);
    this.deferred.delete(sessionId);
  }

  private async runPrompt(
    session: SessionInfo,
    input: PromptInput,
    signal: AbortSignal,
  ): Promise<PromptResult> {
    const agent = this.deps.agents.require(input.agent ?? session.agent);
    const stored = await this.deps.store.messages(session.id);
    const history = await commitPendingRevert(this.rt, session, stored);
    const text = await this.applyChatMessageHook(session.id, input.text);
    const userInfo = await appendUserMessage(this.rt, history, { session, agent, input, text });
    if (this.shouldGenerateTitle(session, input, history)) {
      // best effort: a failed title must never fail the prompt
      void generateTitle(this.rt, session, text).catch(() => {});
    }
    const gate = this.gates.gateFor(session, agent);
    return runSteps(this.rt, {
      session,
      agent,
      history,
      userInfo,
      gate,
      signal,
      input,
      loop: this,
    });
  }

  /** `chat.message` hooks may rewrite the user's text before it is stored. */
  private async applyChatMessageHook(sessionId: string, text: string): Promise<string> {
    const out = { text };
    await this.rt.hooks.run("chat.message", { sessionId }, out);
    return out.text;
  }

  /** Only a top-level prompt on an untitled session that has no assistant reply yet. */
  private shouldGenerateTitle(
    session: SessionInfo,
    input: PromptInput,
    history: MessageWithParts[],
  ): boolean {
    if (!this.cfg.autoTitle || session.title) return false;
    if ((input.depth ?? 0) !== 0) return false;
    return !history.some((m) => m.info.role === "assistant");
  }
}

// ---------- errors ----------
export class SessionBusyError extends Error {
  constructor(id: string) {
    super(`session ${id} is busy`);
    this.name = "SessionBusyError";
  }
}
