// In-process event bus: assigns per-session sequence numbers, fans out to subscribers,
// and keeps a bounded ring per session so a reconnecting client can resume from
// Last-Event-ID without the events ever being persisted.

import type { ExaEvent } from "@exa/protocol";
import type { EventSink } from "../models/ports.model.ts";

// ---------- constants ----------
const DEFAULT_RING_SIZE = 2000;

// ---------- types ----------
type Listener = (e: ExaEvent) => void;

interface Channel {
  seq: number;
  ring: ExaEvent[];
  listeners: Set<Listener>;
  touched: number;
}

// ---------- event bus ----------
export class EventBus implements EventSink {
  private readonly channels = new Map<string, Channel>();
  private readonly global = new Set<Listener>();

  constructor(private readonly ringSize = DEFAULT_RING_SIZE) {}

  publish(e: ExaEvent): void {
    const c = this.channel(e.sessionId);
    const ev = { ...e, seq: ++c.seq } as ExaEvent;
    c.ring.push(ev);
    if (c.ring.length > this.ringSize) c.ring.splice(0, c.ring.length - this.ringSize);
    c.touched = Date.now();
    for (const l of c.listeners) notifySafely(l, ev);
    for (const l of this.global) notifySafely(l, ev);
  }

  /** Subscribe to one session. Replays buffered events with seq > `after` first. */
  subscribe(sessionId: string, listener: Listener, after?: number): () => void {
    const c = this.channel(sessionId);
    if (after !== undefined) {
      for (const e of c.ring) if (e.seq > after) notifySafely(listener, e);
    }
    c.listeners.add(listener);
    return () => c.listeners.delete(listener);
  }

  subscribeAll(listener: Listener): () => void {
    this.global.add(listener);
    return () => this.global.delete(listener);
  }

  /** Oldest seq still buffered (resume from before this needs a full reload). */
  oldestSeq(sessionId: string): number {
    return this.channels.get(sessionId)?.ring[0]?.seq ?? 0;
  }

  lastSeq(sessionId: string): number {
    return this.channels.get(sessionId)?.seq ?? 0;
  }

  /** Free channels idle for longer than `ms` with no listeners. */
  sweep(ms: number): number {
    const cutoff = Date.now() - ms;
    let n = 0;
    for (const [id, c] of this.channels) {
      if (c.listeners.size === 0 && c.touched < cutoff) {
        this.channels.delete(id);
        n++;
      }
    }
    return n;
  }

  drop(sessionId: string): void {
    this.channels.delete(sessionId);
  }

  private channel(sessionId: string): Channel {
    let c = this.channels.get(sessionId);
    if (!c) {
      c = { seq: 0, ring: [], listeners: new Set(), touched: Date.now() };
      this.channels.set(sessionId, c);
    }
    return c;
  }
}

// ---------- tee sink ----------
/** Fan one event stream out to several sinks. */
export class TeeSink implements EventSink {
  constructor(private readonly sinks: EventSink[]) {}

  publish(e: ExaEvent): void {
    for (const s of this.sinks) s.publish(e);
  }
}

// ---------- helpers ----------
function notifySafely(l: Listener, e: ExaEvent): void {
  try {
    l(e);
  } catch {
    // a broken subscriber must never break the loop
  }
}
