// Session entities on the server: stored session metadata, the client-loop lease holder,
// and approval rows.
import type { SessionInfo } from "@exa/protocol";

// ---------- types ----------
export interface SessionMeta extends SessionInfo {
  permissionMode: string;
}

/** A session as loaded for a request (metadata + permission mode). */
export type StoredSession = SessionMeta;

/** Who drives a session's loop: a device (client loop) or a server node. */
export interface LeaseHolder {
  type: "device" | "server";
  id: string;
}

export interface NewApproval {
  id: string;
  sessionId: string;
  permission: string;
  tool?: string;
  patterns: string[];
  title: string;
  ttlMs?: number;
}

/** Approval rows as the repository returns them (snake_case columns). */
export interface PendingApprovalRow {
  id: string;
  permission: string;
  tool: string;
  patterns: string[];
  title: string;
  requested_at: string | Date;
}
