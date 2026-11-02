// Session lifecycle: create (storage mode + model policy), read, update, forget, and the
// server-loop controls (prompt, abort, revert, compact, permission replies).

import {
  type api,
  isUuid,
  makeEvent,
  newId,
  type PermissionReply,
  type SessionInfo,
  type StorageMode,
  zeroTokens,
} from "@exa/protocol";
import { isModelAllowed } from "@exa/router";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { isAdmin } from "../helpers/role.helper.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { PendingApprovalRow, StoredSession } from "../models/session.model.ts";
import type { ResolvedSettings } from "../models/settings.model.ts";
import type { ServiceDeps } from "./service-deps.ts";
import { resolveStorageMode } from "./storage-mode.helper.ts";

// ---------- constants ----------
const DEFAULT_MODEL = "exa";
const DEFAULT_AGENT = "build";

// ---------- types ----------
type CreateSessionInput = z.infer<typeof api.CreateSessionBody>;
type PatchSessionInput = z.infer<typeof api.PatchSessionBody>;
type PromptInput = z.infer<typeof api.PromptBody>;
type RevertInput = z.infer<typeof api.RevertBody>;
type SessionPatch = Partial<SessionInfo> & { permissionMode?: string };

// ---------- session service ----------
export class SessionService {
  constructor(private readonly deps: ServiceDeps) {}

  async create(p: Principal, input: CreateSessionInput): Promise<StoredSession> {
    const projectId = input.projectId ?? null;
    const settings = await this.deps.settings({
      tenantId: p.tenantId,
      userId: p.userId,
      projectId,
    });
    const storageMode = resolveStorageMode(settings, input.loopHost, input.storageMode);
    const model = input.model ?? String(settings.values["models.default"] ?? DEFAULT_MODEL);
    assertModelAllowed(settings, model, `model "${model}" is not allowed by your organization`);
    if (input.parentId) await this.assertOwnParent(p, input.parentId);
    const mode = this.deps.policy.effectiveMode(settings, input.permissionMode);
    const info = newSessionInfo(p, input, { model, storageMode });
    await this.persistNew(p, info, mode);
    this.deps.bus.publish(makeEvent("session.created", info.id, { info }));
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      sessionId: info.id,
      action: "session.created",
      target: `${input.loopHost}/${storageMode}`,
    });
    return { ...info, permissionMode: mode };
  }

  list(p: Principal, opts: { limit: number; parentId: string | null }): Promise<SessionInfo[]> {
    return this.deps.sessions.list(p.tenantId, p.userId, opts);
  }

  /** A session the principal may read: their own, or any in the tenant for admins. 404 otherwise. */
  loadReadable(p: Principal, id: string): Promise<StoredSession> {
    return this.find(p, id, isAdmin(p));
  }

  /** A session the principal may change: only their own. 404 otherwise. */
  loadWritable(p: Principal, id: string): Promise<StoredSession> {
    return this.find(p, id, false);
  }

  /** A writable session whose agent loop runs on the server; 409 for client-loop sessions. */
  async loadServerLoop(p: Principal, id: string, wrongHostMessage: string): Promise<StoredSession> {
    const session = await this.loadWritable(p, id);
    if (session.loopHost !== "server")
      throw new HttpError(409, wrongHostMessage, ERROR_CODES.wrongHost);
    return session;
  }

  /** A writable session whose agent loop runs on a client; 409 for server-loop sessions. */
  async loadClientLoop(p: Principal, id: string, wrongHostMessage: string): Promise<StoredSession> {
    const session = await this.loadWritable(p, id);
    if (session.loopHost !== "client")
      throw new HttpError(409, wrongHostMessage, ERROR_CODES.wrongHost);
    return session;
  }

  /** Session info plus whatever the server holds: messages, pending approvals, lease, liveness. */
  async detail(p: Principal, session: StoredSession) {
    const hasServerContent = session.storageMode === "server" || session.loopHost === "server";
    const messages = hasServerContent
      ? await this.deps.runtime.storeFor(p.tenantId).messages(session.id)
      : null;
    const [pending, lease] = await Promise.all([
      this.deps.sessions.pendingApprovals(p.tenantId, session.id),
      this.deps.sessions.currentLease(p.tenantId, session.id),
    ]);
    return {
      info: session,
      messages,
      pendingApprovals: (pending as PendingApprovalRow[]).map((row) =>
        approvalFromRow(row, session.id),
      ),
      lease,
      busy: this.deps.runtime.isBusy(session.id),
      lastSeq: this.deps.bus.lastSeq(session.id),
    };
  }

  async update(p: Principal, session: StoredSession, input: PatchSessionInput) {
    const patch: SessionPatch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.agent) patch.agent = input.agent;
    if (input.model) patch.model = await this.allowedModel(p, session, input.model);
    if (input.permissionMode)
      patch.permissionMode = await this.allowedMode(p, session, input.permissionMode);
    if (input.archived !== undefined) {
      const archived = input.archived ? Date.now() : undefined;
      patch.time = { ...session.time, archived };
    }
    await this.deps.sessions.update(p.tenantId, session.id, patch);
    this.deps.bus.publish(
      makeEvent("session.updated", session.id, { info: { id: session.id, ...patch } }),
    );
    return { ...session, ...patch };
  }

  /** "Forget": stops any live loop and deletes the session with everything hanging off it. */
  async forget(p: Principal, session: StoredSession): Promise<void> {
    await this.deps.runtime.forget(p.tenantId, session.id);
    await this.deps.sessions.delete(p.tenantId, session.id);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      sessionId: session.id,
      action: "session.forgotten",
    });
  }

  async prompt(p: Principal, session: StoredSession, input: PromptInput): Promise<void> {
    await this.deps.runtime.prompt(p, session, input);
  }

  /** Server loops abort here; for client loops the request is forwarded over the event stream. */
  abort(p: Principal, session: StoredSession): { aborted: boolean; forwarded?: boolean } {
    if (session.loopHost === "server") return { aborted: this.deps.runtime.abort(session.id) };
    this.deps.bus.publish(makeEvent("session.abort", session.id, { by: p.userId }));
    return { aborted: true, forwarded: true };
  }

  async revert(p: Principal, session: StoredSession, input: RevertInput): Promise<void> {
    await this.deps.runtime.revert(p, session, input.messageId, input.partId);
  }

  async unrevert(p: Principal, session: StoredSession): Promise<void> {
    await this.deps.runtime.unrevert(p, session);
  }

  async compact(p: Principal, session: StoredSession): Promise<boolean> {
    return this.deps.runtime.compact(p, session);
  }

  /** First answer from any attached client wins. */
  async replyPermission(
    p: Principal,
    session: StoredSession,
    requestId: string,
    reply: PermissionReply,
  ): Promise<void> {
    const ok = await this.deps.approvals.reply(p.tenantId, session.id, requestId, reply, p.userId);
    if (!ok) throw new HttpError(409, "already answered or expired", ERROR_CODES.conflict);
  }

  private async find(p: Principal, id: string, canReadOthers: boolean): Promise<StoredSession> {
    if (!isUuid(id)) throw notFound();
    const session = await this.deps.sessions.get(p.tenantId, id);
    if (!session) throw notFound();
    const isOwner = session.userId === p.userId;
    if (!isOwner && !canReadOthers) throw notFound();
    return session;
  }

  private async assertOwnParent(p: Principal, parentId: string): Promise<void> {
    const parent = await this.deps.sessions.get(p.tenantId, parentId);
    if (!parent || parent.userId !== p.userId)
      throw new HttpError(404, "parent session not found", ERROR_CODES.notFound);
  }

  private async persistNew(p: Principal, info: SessionInfo, mode: string): Promise<void> {
    if (info.loopHost !== "server") {
      await this.deps.sessions.create(info, mode);
      return;
    }
    await this.deps.runtime.storeFor(p.tenantId).createSession(info);
    if (mode !== "default")
      await this.deps.sessions.update(p.tenantId, info.id, { permissionMode: mode });
  }

  private async allowedModel(p: Principal, session: StoredSession, model: string): Promise<string> {
    const settings = await this.settingsFor(p, session);
    assertModelAllowed(settings, model, `model "${model}" is not allowed`);
    return model;
  }

  private async allowedMode(p: Principal, session: StoredSession, requested: string) {
    const settings = await this.settingsFor(p, session);
    const effective = this.deps.policy.effectiveMode(settings, requested);
    if (effective !== requested)
      throw new HttpError(
        403,
        `permission mode "${requested}" is not allowed`,
        ERROR_CODES.forbidden,
      );
    return effective;
  }

  private settingsFor(p: Principal, session: StoredSession): Promise<ResolvedSettings> {
    return this.deps.settings({
      tenantId: p.tenantId,
      userId: p.userId,
      projectId: session.projectId,
    });
  }
}

// ---------- helpers ----------
function notFound(): HttpError {
  return new HttpError(404, "session not found", ERROR_CODES.notFound);
}

function assertModelAllowed(settings: ResolvedSettings, model: string, message: string): void {
  const policy = {
    allowed: settings.values["models.allowed"] as string[],
    byokEnabled: true,
    poolForDirect: false,
  };
  if (!isModelAllowed(policy, model)) throw new HttpError(403, message, ERROR_CODES.forbidden);
}

function newSessionInfo(
  p: Principal,
  input: CreateSessionInput,
  resolved: { model: string; storageMode: StorageMode },
): SessionInfo {
  const now = Date.now();
  const isClientLoop = input.loopHost === "client";
  return {
    id: newId(),
    tenantId: p.tenantId,
    userId: p.userId,
    projectId: input.projectId ?? null,
    parentId: input.parentId ?? null,
    title: input.title ?? null,
    directory: isClientLoop ? (input.directory ?? null) : null,
    agent: input.agent ?? DEFAULT_AGENT,
    model: resolved.model,
    loopHost: input.loopHost,
    storageMode: resolved.storageMode,
    status: "active",
    revert: null,
    tokens: zeroTokens(),
    cost: 0,
    time: { created: now, updated: now },
  };
}

function approvalFromRow(row: PendingApprovalRow, sessionId: string) {
  return {
    id: row.id,
    sessionId,
    permission: row.permission,
    tool: row.tool,
    patterns: row.patterns,
    title: row.title,
    time: new Date(row.requested_at).getTime(),
  };
}
