// Permission approvals, held server-side so ANY attached client (web, phone, the CLI itself)
// can answer. Shared by both loop kinds: server loops wait on it, client loops only record.

import type { EventBus } from "@exa/core";
import { makeEvent, type PermissionReply, type PermissionRequest } from "@exa/protocol";
import type { SessionRepo } from "../repositories/session.repository.ts";
import type { TelemetryWriter } from "../repositories/telemetry.repository.ts";

// ---------- constants ----------
/** How often a waiting server loop checks the DB for an answer recorded by another node. */
const DB_POLL_INTERVAL_MS = 1500;
const TIMEOUT_ACTOR = "system:timeout";
const UUID_SHAPE = /^[0-9a-f-]{36}$/;

// ---------- types ----------
interface Waiter {
  resolve: (reply: PermissionReply) => void;
  timer: ReturnType<typeof setTimeout>;
  poll: ReturnType<typeof setInterval>;
}

// ---------- approval broker ----------
export class ApprovalBroker {
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly sessions: SessionRepo,
    private readonly bus: EventBus,
    private readonly telemetry: TelemetryWriter,
    private readonly timeoutMs: number,
  ) {}

  /** Store a pending request without announcing it (client loops publish their own event). */
  async record(tenantId: string, req: PermissionRequest): Promise<void> {
    await this.sessions.createApproval(tenantId, {
      id: req.id,
      sessionId: req.sessionId,
      permission: req.permission,
      tool: req.tool,
      patterns: req.patterns,
      title: req.title,
      ttlMs: this.timeoutMs,
    });
  }

  /** Record + announce a request from a server loop, then wait for the first answer. */
  async ask(
    tenantId: string,
    req: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionReply> {
    await this.record(tenantId, req);
    this.bus.publish(makeEvent("permission.asked", req.sessionId, { request: req }));
    return new Promise<PermissionReply>((resolve) => this.wait(tenantId, req, resolve, signal));
  }

  /** First answer wins; later answers get `false`. */
  async reply(
    tenantId: string,
    sessionId: string,
    requestId: string,
    reply: PermissionReply,
    by: string,
  ): Promise<boolean> {
    const deciderUserId = UUID_SHAPE.test(by) ? by : null;
    const decided = await this.sessions.decideApproval(
      tenantId,
      sessionId,
      requestId,
      reply,
      deciderUserId,
    );
    if (!decided) return false;
    this.bus.publish(makeEvent("permission.replied", sessionId, { requestId, reply, by }));
    this.telemetry.recordAudit({
      tenantId,
      actorUserId: by,
      sessionId,
      action: "approval.decided",
      target: requestId,
      decision: reply,
    });
    this.settle(requestId, reply);
    return true;
  }

  private wait(
    tenantId: string,
    req: PermissionRequest,
    resolve: (reply: PermissionReply) => void,
    signal?: AbortSignal,
  ): void {
    const timer = setTimeout(() => {
      void this.reply(tenantId, req.sessionId, req.id, "reject", TIMEOUT_ACTOR);
    }, this.timeoutMs);
    // Multi-node: the answer may be recorded by another server node, so check the DB too.
    const poll = setInterval(() => void this.pollDecision(tenantId, req.id), DB_POLL_INTERVAL_MS);
    this.waiters.set(req.id, { resolve, timer, poll });
    signal?.addEventListener("abort", () => this.settle(req.id, "reject"), { once: true });
  }

  private async pollDecision(tenantId: string, requestId: string): Promise<void> {
    if (!this.waiters.has(requestId)) return;
    const state = await this.sessions
      .approvalState(tenantId, requestId)
      .catch(() => "pending" as const);
    if (!state || state === "pending") return;
    this.settle(requestId, state === "once" || state === "always" ? state : "reject");
  }

  private settle(requestId: string, reply: PermissionReply): void {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    clearInterval(waiter.poll);
    this.waiters.delete(requestId);
    waiter.resolve(reply);
  }
}
