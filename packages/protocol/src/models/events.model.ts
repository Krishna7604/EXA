// Event stream. Every state change in a session becomes one of these; clients never poll.
// Wire name is `${type}@${v}` so the schema can evolve: a client ignores versions it doesn't know.

import type { MessageInfo, Part, SessionInfo } from "./messages.model.ts";

// ---------- types ----------
export type PermissionReply = "once" | "always" | "reject";

export interface PermissionRequest {
  id: string;
  sessionId: string;
  messageId?: string;
  callId?: string;
  /** Permission key: read | edit | bash | external_directory | doom_loop | webfetch | task | skill ... */
  permission: string;
  /** The resources that matched `ask` (paths, parsed commands, URLs). */
  patterns: string[];
  tool?: string;
  title: string;
  metadata?: Record<string, unknown>;
  time: number;
}

export type EventPayloads = {
  "session.created": { info: SessionInfo };
  "session.updated": { info: Partial<SessionInfo> & { id: string } };
  "session.status": { status: "busy" | "idle" | "retry"; detail?: string };
  "session.idle": Record<string, never>;
  "session.error": { error: { name: string; message: string } };
  "session.compacted": { messageId: string };
  "message.updated": { info: MessageInfo };
  "message.removed": { messageId: string };
  "message.part.updated": { part: Part };
  /** Streaming delta: appended to a text/reasoning part. Never persisted. */
  "message.part.delta": { messageId: string; partId: string; field: "text"; delta: string };
  "permission.asked": { request: PermissionRequest };
  "permission.replied": { requestId: string; reply: PermissionReply; by?: string };
  "todo.updated": { todos: Array<{ content: string; status: string; priority?: string }> };
  "lease.changed": { holder: { type: "device" | "server"; id: string } | null; fencing: number };
  usage: { model: string; tokens: Record<string, number>; cost: number };
  /** A viewer asked the loop host to stop the current turn. */
  "session.abort": { by: string };
  /** The requested resume point is no longer buffered: reload full state, then continue. */
  "session.resync": { fromSeq: number };
};

export type EventType = keyof EventPayloads;

export interface ExaEvent<T extends EventType = EventType> {
  type: T;
  v: number;
  sessionId: string;
  /** Per-session monotonic sequence assigned by the bus; 0 before publishing. */
  seq: number;
  time: number;
  data: EventPayloads[T];
}

export type AnyEvent = { [K in EventType]: ExaEvent<K> }[EventType];
