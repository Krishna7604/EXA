// Building events (stamped with their schema version) and classifying them for durability.

import { EVENT_VERSION } from "../constants/protocol.constants.ts";
import type { EventPayloads, EventType, ExaEvent } from "../models/events.model.ts";

// ---------- events ----------
export function makeEvent<T extends EventType>(
  type: T,
  sessionId: string,
  data: EventPayloads[T],
): ExaEvent<T> {
  return { type, v: EVENT_VERSION[type], sessionId, seq: 0, time: Date.now(), data };
}

/** Deltas are ephemeral: forwarded live but excluded from durable outboxes. */
export function isEphemeral(e: ExaEvent): boolean {
  return e.type === "message.part.delta" || e.type === "session.status";
}
