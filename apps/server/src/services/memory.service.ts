// Long-term memory: the per-user CRUD and search behind /v1/memories and /v1/search, and the
// MemoryPort the server runtime hands to a chat's agent loop (memory tools + <memory> prompt).

import type { MemoryPort } from "@exa/core";
import { type api, type ChatSearchHit, isUuid, type MemoryItem } from "@exa/protocol";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { ServiceDeps } from "./service-deps.ts";

// ---------- constants ----------
/** Per-user cap; the agent has to forget something before saving more. */
export const MAX_MEMORIES_PER_USER = 500;
/** Upper bound for one search, whoever asks (API or the recall tool). */
const MAX_SEARCH_RESULTS = 50;

// ---------- types ----------
type MemoryInput = z.infer<typeof api.PutMemoryBody>;

/** Whose memory: a request's Principal, or the owner of a chat the runtime is serving. */
export interface MemoryOwner {
  tenantId: string;
  userId: string;
}

/** A write from a chat carries the chat's id; from the API it doesn't. */
interface MemoryWrite extends MemoryInput {
  sessionId?: string;
}

type MemoryDeps = Pick<ServiceDeps, "memories" | "telemetry">;

// ---------- memory service ----------
export class MemoryService {
  constructor(private readonly deps: MemoryDeps) {}

  list(owner: MemoryOwner, limit: number): Promise<MemoryItem[]> {
    return this.deps.memories.list(owner.tenantId, owner.userId, limit);
  }

  search(owner: MemoryOwner, query: string, limit: number): Promise<MemoryItem[]> {
    const capped = Math.min(limit, MAX_SEARCH_RESULTS);
    return this.deps.memories.search(owner.tenantId, owner.userId, query, capped);
  }

  searchChats(owner: MemoryOwner, query: string, limit: number): Promise<ChatSearchHit[]> {
    const capped = Math.min(limit, MAX_SEARCH_RESULTS);
    return this.deps.memories.searchChats(owner.tenantId, owner.userId, query, capped);
  }

  /** 409 `limit_reached` once the user has MAX_MEMORIES_PER_USER memories. */
  async create(owner: MemoryOwner, input: MemoryWrite): Promise<MemoryItem> {
    const count = await this.deps.memories.count(owner.tenantId, owner.userId);
    if (count >= MAX_MEMORIES_PER_USER) throw memoryFull();
    const item = await this.deps.memories.create(owner.tenantId, owner.userId, {
      topic: input.topic,
      content: input.content,
      sourceSessionId: sourceSession(input.sessionId),
    });
    this.audit(owner, "memory.created", item.id, input.sessionId);
    return item;
  }

  /** 404 unless the memory exists and is the caller's. A chat's edit re-points its source. */
  async update(owner: MemoryOwner, id: string, input: MemoryWrite): Promise<MemoryItem> {
    const fields = {
      topic: input.topic,
      content: input.content,
      sourceSessionId: input.sessionId === undefined ? undefined : sourceSession(input.sessionId),
    };
    const item = isUuid(id)
      ? await this.deps.memories.update(owner.tenantId, owner.userId, id, fields)
      : null;
    if (!item) throw notFound();
    this.audit(owner, "memory.updated", item.id, input.sessionId);
    return item;
  }

  async remove(owner: MemoryOwner, id: string): Promise<void> {
    if (!(await this.forget(owner, id))) throw notFound();
  }

  /** The memory a chat of this user sees: tools write through the same rules as the API. */
  portFor(tenantId: string, userId: string): MemoryPort {
    const owner = { tenantId, userId };
    return {
      list: (limit) => this.list(owner, limit),
      save: ({ id, ...input }) =>
        id === undefined ? this.create(owner, input) : this.update(owner, id, input),
      forget: (id) => this.forget(owner, id),
      search: (query, limit) => this.search(owner, query, limit),
      searchChats: (query, limit) => this.searchChats(owner, query, limit),
    };
  }

  private async forget(owner: MemoryOwner, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const isDeleted = await this.deps.memories.delete(owner.tenantId, owner.userId, id);
    if (isDeleted) this.audit(owner, "memory.deleted", id);
    return isDeleted;
  }

  private audit(owner: MemoryOwner, action: string, memoryId: string, sessionId?: string): void {
    this.deps.telemetry.recordAudit({
      tenantId: owner.tenantId,
      actorUserId: owner.userId,
      sessionId: sourceSession(sessionId) ?? undefined,
      action,
      target: memoryId,
    });
  }
}

// ---------- helpers ----------
/** Only a real session id is linked (CLI-local or test ids are not sessions on this server). */
function sourceSession(sessionId: string | undefined): string | null {
  return sessionId && isUuid(sessionId) ? sessionId : null;
}

function notFound(): HttpError {
  return new HttpError(404, "memory not found", ERROR_CODES.notFound);
}

function memoryFull(): HttpError {
  return new HttpError(
    409,
    `memory is full (${MAX_MEMORIES_PER_USER} memories): forget or update one first`,
    ERROR_CODES.limitReached,
    { limit: MAX_MEMORIES_PER_USER },
  );
}
