// Client-loop sessions (heavy clients run the agent loop): the driving lease, and ingest of the
// client's events. Ingested events are fanned out to every attached client and mirrored into
// server state (titles, costs, approvals, todos, audit, stored content).

import {
  type api,
  EVENT_VERSION,
  type EventType,
  type ExaEvent,
  isUuid,
  type MessageInfo,
  makeEvent,
  type Part,
  type PermissionReply,
  type PermissionRequest,
  type SessionInfo,
  type Tokens,
  zeroTokens,
} from "@exa/protocol";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { StoredSession } from "../models/session.model.ts";
import type { ServiceDeps } from "./service-deps.ts";

// ---------- constants ----------
const DEFAULT_LEASE_TTL_MS = 60_000;
/** Max child sessions (task-tool subagents) considered part of one session tree. */
const MAX_CHILD_SESSIONS = 200;
const MAX_TITLE_CHARS = 300;
const MAX_TODOS = 100;

// ---------- types ----------
type LeaseInput = z.infer<typeof api.LeaseBody>;
type ClientEventsInput = z.infer<typeof api.ClientEventsBody>;
type ClientEvent = ClientEventsInput["events"][number];
type PersistedStep = NonNullable<ClientEventsInput["persist"]>[number];

/** Lease state after acquire/renew; null after a release. */
export type LeaseResult = { fencing: number; ttlMs: number } | null;

/** The loosely-typed payload of a client event: only the fields we mirror are read. */
interface ClientEventData {
  info?: {
    id?: unknown;
    parentId?: unknown;
    title?: unknown;
    tokens?: { input?: unknown };
    cost?: unknown;
    revert?: unknown;
  };
  request?: PermissionRequest;
  requestId?: unknown;
  reply?: PermissionReply;
  todos?: unknown;
  part?: { type?: string; tool?: string; state?: { status?: string } };
}

interface IngestContext {
  p: Principal;
  root: StoredSession;
  /** Ids of the root session and its children; events for anything else are dropped. */
  tree: Set<string>;
}

// ---------- client sync service ----------
export class ClientSyncService {
  constructor(private readonly deps: ServiceDeps) {}

  async lease(p: Principal, session: StoredSession, input: LeaseInput): Promise<LeaseResult> {
    const holder = { type: "device" as const, id: holderId(p) };
    const ttl = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    const sessions = this.deps.sessions;
    if (input.action === "acquire") {
      const fencing = await sessions.acquireLease(p.tenantId, session.id, holder, ttl);
      if (fencing === null)
        throw new HttpError(409, "another client is driving this session", ERROR_CODES.leaseHeld);
      this.deps.bus.publish(makeEvent("lease.changed", session.id, { holder, fencing }));
      return { fencing, ttlMs: ttl };
    }
    if (input.fencing === undefined)
      throw new HttpError(400, "fencing required", ERROR_CODES.validation);
    if (input.action === "renew") {
      const renewed = await sessions.renewLease(p.tenantId, session.id, holder, input.fencing, ttl);
      if (!renewed) throw new HttpError(409, "lease lost", ERROR_CODES.leaseLost);
      return { fencing: input.fencing, ttlMs: ttl };
    }
    await sessions.releaseLease(p.tenantId, session.id, holder, input.fencing);
    const released = { holder: null, fencing: input.fencing };
    this.deps.bus.publish(makeEvent("lease.changed", session.id, released));
    return null;
  }

  async ingest(
    p: Principal,
    session: StoredSession,
    input: ClientEventsInput,
  ): Promise<{ ok: true; accepted: number }> {
    await this.assertLeaseHolder(p, session, input.fencing);
    const ctx: IngestContext = { p, root: session, tree: await this.sessionTree(p, session) };
    for (const event of input.events) await this.ingestEvent(ctx, event);
    if (input.persist?.length && session.storageMode === "server")
      await this.persistSteps(ctx, input.persist);
    return { ok: true, accepted: input.events.length };
  }

  private async assertLeaseHolder(
    p: Principal,
    session: StoredSession,
    fencing: number,
  ): Promise<void> {
    const lease = await this.deps.sessions.currentLease(p.tenantId, session.id);
    const isHolder = lease?.fencing === fencing && lease.holderId === holderId(p);
    if (!isHolder)
      throw new HttpError(409, "stale or missing lease (fencing mismatch)", ERROR_CODES.leaseLost);
  }

  /** Child sessions created by the task tool on the client belong to this session tree. */
  private async sessionTree(p: Principal, root: StoredSession): Promise<Set<string>> {
    const tree = new Set<string>([root.id]);
    const children = await this.deps.sessions.list(p.tenantId, p.userId, {
      parentId: root.id,
      limit: MAX_CHILD_SESSIONS,
    });
    for (const child of children) tree.add(child.id);
    return tree;
  }

  private async ingestEvent(ctx: IngestContext, event: ClientEvent): Promise<void> {
    if (!(event.type in EVENT_VERSION)) return;
    const type = event.type as EventType;
    const target = event.sessionId ?? ctx.root.id;
    const data = event.data as ClientEventData | undefined;
    if (type === "session.created" && this.isNewChild(ctx, data)) await this.adoptChild(ctx, data);
    if (!ctx.tree.has(target)) return;
    await this.applySideEffects(ctx, target, type, data);
    this.deps.bus.publish({
      type,
      v: event.v,
      sessionId: target,
      seq: 0,
      time: event.time ?? Date.now(),
      data: event.data,
    } as ExaEvent);
  }

  private isNewChild(ctx: IngestContext, data: ClientEventData | undefined): boolean {
    const info = data?.info;
    if (info?.parentId !== ctx.root.id) return false;
    return isUuid(info.id) && !ctx.tree.has(info.id);
  }

  private async adoptChild(ctx: IngestContext, data: ClientEventData | undefined): Promise<void> {
    const child = data?.info as unknown as SessionInfo;
    await this.deps.sessions.create({
      ...child,
      tenantId: ctx.p.tenantId,
      userId: ctx.p.userId,
      loopHost: "client",
      storageMode: ctx.root.storageMode,
      parentId: ctx.root.id,
    });
    ctx.tree.add(child.id);
  }

  private async applySideEffects(
    ctx: IngestContext,
    sessionId: string,
    type: EventType,
    data: ClientEventData | undefined,
  ): Promise<void> {
    switch (type) {
      case "session.updated":
        return this.mirrorSessionUpdate(ctx, sessionId, data);
      case "permission.asked":
        return this.mirrorApprovalAsked(ctx, sessionId, data);
      case "permission.replied":
        return this.mirrorApprovalReplied(ctx, sessionId, data);
      case "todo.updated":
        return this.mirrorTodos(ctx, sessionId, data);
      case "message.part.updated":
        return this.auditToolRun(ctx, sessionId, data);
    }
  }

  private async mirrorSessionUpdate(
    ctx: IngestContext,
    sessionId: string,
    data: ClientEventData | undefined,
  ): Promise<void> {
    const patch = sessionPatchFrom(data?.info ?? {});
    if (Object.keys(patch).length)
      await this.deps.sessions.update(ctx.p.tenantId, sessionId, patch);
  }

  private async mirrorApprovalAsked(
    ctx: IngestContext,
    sessionId: string,
    data: ClientEventData | undefined,
  ): Promise<void> {
    const req = data?.request;
    if (req && isUuid(req.id))
      await this.deps.approvals.record(ctx.p.tenantId, { ...req, sessionId });
  }

  private async mirrorApprovalReplied(
    ctx: IngestContext,
    sessionId: string,
    data: ClientEventData | undefined,
  ): Promise<void> {
    const requestId = data?.requestId;
    if (!isUuid(requestId)) return;
    const reply = data?.reply as PermissionReply;
    const { p } = ctx;
    await this.deps.sessions.decideApproval(p.tenantId, sessionId, requestId, reply, p.userId);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      sessionId,
      action: "approval.decided",
      target: requestId,
      decision: reply,
    });
  }

  private async mirrorTodos(
    ctx: IngestContext,
    sessionId: string,
    data: ClientEventData | undefined,
  ): Promise<void> {
    const todos = data?.todos;
    if (ctx.root.storageMode !== "server" || !Array.isArray(todos)) return;
    await this.deps.sessions.putTodos(ctx.p.tenantId, sessionId, todos.slice(0, MAX_TODOS));
  }

  private auditToolRun(ctx: IngestContext, sessionId: string, data: ClientEventData | undefined) {
    const part = data?.part;
    const status = part?.state?.status;
    if (part?.type !== "tool" || (status !== "completed" && status !== "error")) return;
    this.deps.telemetry.recordAudit({
      tenantId: ctx.p.tenantId,
      actorUserId: ctx.p.userId,
      sessionId,
      device: ctx.p.tokenId,
      action: "tool.run",
      target: part.tool,
      decision: status,
    });
  }

  /** Final-state steps for storage=server; anything outside the session tree is ignored. */
  private async persistSteps(ctx: IngestContext, steps: PersistedStep[]): Promise<void> {
    for (const step of steps) {
      const info = step.info as unknown as MessageInfo;
      if (!ctx.tree.has(info.sessionId) || !isUuid(info.id)) continue;
      const parts = (step.parts as unknown as Part[]).filter(
        (x) => x.sessionId === info.sessionId && x.messageId === info.id && isUuid(x.id),
      );
      await this.deps.sessions.putStep(ctx.p.tenantId, info, parts);
    }
  }
}

// ---------- helpers ----------
/** Who holds a client lease: the API token (CLI/device) or the user's browser session. */
function holderId(p: Principal): string {
  return p.tokenId ?? `web:${p.userId}`;
}

/** Only well-formed fields from a client's session.updated event are mirrored. */
function sessionPatchFrom(info: NonNullable<ClientEventData["info"]>): Partial<SessionInfo> {
  const patch: Partial<SessionInfo> = {};
  if (typeof info.title === "string") patch.title = info.title.slice(0, MAX_TITLE_CHARS);
  if (info.tokens && typeof info.tokens.input === "number")
    patch.tokens = { ...zeroTokens(), ...(info.tokens as Partial<Tokens>) };
  if (typeof info.cost === "number" && info.cost >= 0) patch.cost = info.cost;
  if (info.revert !== undefined) patch.revert = info.revert as SessionInfo["revert"];
  return patch;
}
