// Row mapping and write statements for the session tables, shared by SessionRepo's methods
// (some run inside a larger transaction, so they take a transaction handle rather than a Db).
import type { MessageInfo, Part, SessionInfo } from "@exa/protocol";
import { type DbTx, messages, parts as partsTable, sessions } from "@exa/store";
import { eq, sql } from "drizzle-orm";

// ---------- types ----------
type SessionRow = typeof sessions.$inferSelect;
type SessionPatch = Partial<SessionInfo> & { permissionMode?: string };

// ---------- row mapping ----------
export function sessionFromRow(r: SessionRow): SessionInfo {
  return {
    id: r.id,
    tenantId: r.tenantId,
    userId: r.userId,
    projectId: r.projectId ?? null,
    parentId: r.parentId ?? null,
    taskId: r.taskId ?? null,
    title: r.title ?? null,
    directory: r.directory ?? null,
    agent: r.agent,
    model: r.model,
    loopHost: r.loopHost as SessionInfo["loopHost"],
    storageMode: r.storageMode as SessionInfo["storageMode"],
    status: r.status as SessionInfo["status"],
    revert: r.revert ?? null,
    tokens: {
      input: r.tokensInput,
      output: r.tokensOutput,
      reasoning: r.tokensReasoning,
      cacheRead: r.tokensCacheRead,
      cacheWrite: r.tokensCacheWrite,
    },
    cost: r.costUsd,
    time: {
      created: r.createdAt.getTime(),
      updated: r.updatedAt.getTime(),
      ...(r.archivedAt ? { archived: r.archivedAt.getTime() } : {}),
    },
  };
}

// ---------- writes ----------
export async function insertSession(q: DbTx, info: SessionInfo, permissionMode: string) {
  await q.orm.insert(sessions).values({
    id: info.id,
    tenantId: info.tenantId,
    userId: info.userId,
    projectId: info.projectId,
    parentId: info.parentId,
    title: info.title,
    directory: info.directory,
    agent: info.agent,
    model: info.model,
    loopHost: info.loopHost,
    storageMode: info.storageMode,
    permissionMode,
    status: info.status,
    taskId: info.taskId ?? null,
  });
}

export async function updateSession(q: DbTx, id: string, patch: SessionPatch) {
  const set = sessionPatchSet(patch);
  if (Object.values(set).every((v) => v === undefined)) return;
  await q.orm
    .update(sessions)
    .set({ ...set, updatedAt: sql`now()` })
    .where(eq(sessions.id, id));
}

export async function putMessage(q: DbTx, tenantId: string, info: MessageInfo) {
  await q.orm
    .insert(messages)
    .values({
      id: info.id,
      tenantId,
      sessionId: info.sessionId,
      parentId: info.parentId,
      role: info.role,
      data: info,
    })
    .onConflictDoUpdate({ target: messages.id, set: { data: sql`excluded.data` } });
}

export async function putParts(q: DbTx, tenantId: string, parts: Part[]) {
  // one multi-row upsert per step
  const rows = parts.map((p) => ({
    id: p.id,
    tenantId,
    sessionId: p.sessionId,
    messageId: p.messageId,
    type: p.type,
    data: p,
  }));
  await q.orm
    .insert(partsTable)
    .values(rows)
    .onConflictDoUpdate({ target: partsTable.id, set: { data: sql`excluded.data` } });
}

// ---------- helpers ----------
/** The columns a patch changes. Undefined fields are left out of the update by Drizzle. */
function sessionPatchSet(patch: SessionPatch): Partial<typeof sessions.$inferInsert> {
  const t = patch.tokens;
  const archived = patch.time?.archived;
  return {
    title: patch.title,
    agent: patch.agent,
    model: patch.model,
    status: patch.status,
    directory: patch.directory,
    permissionMode: patch.permissionMode,
    revert: patch.revert,
    tokensInput: t?.input,
    tokensOutput: t?.output,
    tokensReasoning: t?.reasoning,
    tokensCacheRead: t?.cacheRead,
    tokensCacheWrite: t?.cacheWrite,
    costUsd: patch.cost,
    archivedAt: archived === undefined ? undefined : new Date(archived),
  };
}
