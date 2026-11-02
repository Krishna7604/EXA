// Protocol versions: the HTTP API version and the current schema version of each event type.

import type { EventType } from "../models/events.model.ts";

// ---------- api ----------
export const PROTOCOL_VERSION = 1;

// ---------- events ----------
export const EVENT_VERSION: Record<EventType, number> = {
  "session.created": 1,
  "session.updated": 1,
  "session.status": 1,
  "session.idle": 1,
  "session.error": 1,
  "session.compacted": 1,
  "message.updated": 1,
  "message.removed": 1,
  "message.part.updated": 1,
  "message.part.delta": 1,
  "permission.asked": 1,
  "permission.replied": 1,
  "todo.updated": 1,
  "lease.changed": 1,
  usage: 1,
  "session.abort": 1,
  "session.resync": 1,
};
