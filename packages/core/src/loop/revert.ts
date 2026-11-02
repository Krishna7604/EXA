// Revert markers: mark a message reverted (restoring files from its step snapshot), undo
// that, or commit it when the next prompt arrives by deleting the reverted messages.

import type { MessageWithParts, SessionInfo } from "@exa/protocol";
import { visibleHistory } from "../context/context.ts";
import { collectPatchedFiles } from "./parts.ts";
import type { LoopRuntime } from "./runtime.ts";

// ---------- revert ----------
export async function markReverted(
  rt: LoopRuntime,
  sessionId: string,
  target: { messageId: string; partId?: string },
): Promise<void> {
  const { messageId, partId } = target;
  await rt.requireSession(sessionId);
  const history = await rt.deps.store.messages(sessionId);
  const idx = history.findIndex((m) => m.info.id === messageId);
  if (idx === -1) throw new Error(`message ${messageId} not found`);
  // restore the workspace to the snapshot taken at the first reverted step
  const reverted = history.slice(idx);
  const snapshot = firstStepSnapshot(reverted);
  if (snapshot && rt.deps.snapshots) {
    const files = collectPatchedFiles(reverted);
    if (files.length) await rt.deps.snapshots.restore(snapshot, files);
  }
  const revert = { messageId, partId, snapshot };
  await rt.deps.store.updateSession(sessionId, { revert });
  rt.emit("session.updated", sessionId, { info: { id: sessionId, revert } });
}

export async function undoRevert(rt: LoopRuntime, sessionId: string): Promise<void> {
  const session = await rt.deps.store.getSession(sessionId);
  if (!session?.revert) return;
  if (rt.deps.snapshots) {
    // re-apply: restore the latest snapshot recorded after the reverted point
    const history = await rt.deps.store.messages(sessionId);
    const latest = latestStepSnapshot(history);
    const files = collectPatchedFiles(history);
    if (latest && files.length) await rt.deps.snapshots.restore(latest, files);
  }
  await rt.deps.store.updateSession(sessionId, { revert: null });
  rt.emit("session.updated", sessionId, { info: { id: sessionId, revert: null } });
}

/** A new prompt commits a pending revert: drop the reverted messages for good. */
export async function commitPendingRevert(
  rt: LoopRuntime,
  session: SessionInfo,
  history: MessageWithParts[],
): Promise<MessageWithParts[]> {
  if (!session.revert) return history;
  const { store } = rt.deps;
  const keep = new Set(visibleHistory(history, session).map((m) => m.info.id));
  const drop = history.filter((m) => !keep.has(m.info.id)).map((m) => m.info.id);
  if (drop.length) await store.deleteMessages(session.id, drop);
  for (const id of drop) rt.emit("message.removed", session.id, { messageId: id });
  session.revert = null;
  await store.updateSession(session.id, { revert: null });
  return history.filter((m) => keep.has(m.info.id));
}

// ---------- helpers ----------
function firstStepSnapshot(messages: MessageWithParts[]): string | undefined {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "step-start" && p.snapshot) return p.snapshot;
    }
  }
  return undefined;
}

function latestStepSnapshot(messages: MessageWithParts[]): string | undefined {
  let latest: string | undefined;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "step-finish" && p.snapshot) latest = p.snapshot;
    }
  }
  return latest;
}
