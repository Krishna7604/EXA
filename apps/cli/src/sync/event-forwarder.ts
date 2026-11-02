// Batches loop events to POST /ingest. Deltas for the same part are merged before sending, and
// message content is mirrored for storage_mode=server.

import type { EventSink } from "@exa/core";
import type { ExaEvent, MessageInfo, Part } from "@exa/protocol";
import type { ExaApi } from "../services/api.service.ts";
import type { LeaseKeeper } from "./lease-keeper.ts";

// ---------- constants ----------
const DEFAULT_INTERVAL_MS = 200;
const MAX_EVENTS_PER_BATCH = 2000;
/** Event types the server sends us; forwarding them back would echo. */
const SERVER_ORIGINATED = new Set(["session.abort", "session.resync", "lease.changed"]);

// ---------- types ----------
interface QueuedEvent {
  type: string;
  v: number;
  data: unknown;
  time: number;
  sessionId: string;
}

interface MirroredMessage {
  info: MessageInfo;
  parts: Map<string, Part>;
}

interface PersistEntry {
  info: MessageInfo;
  parts: Part[];
}

interface Batch {
  events: QueuedEvent[];
  persist: PersistEntry[];
}

interface DeltaData {
  partId: string;
  delta: string;
}

export interface ForwarderOptions {
  intervalMs?: number;
  onError?: (e: unknown) => void;
}

// ---------- event forwarder ----------
export class EventForwarder implements EventSink {
  failures = 0;
  private queue: QueuedEvent[] = [];
  private persist = new Map<string, MirroredMessage>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;

  constructor(
    private readonly api: ExaApi,
    private readonly rootSessionId: string,
    private readonly lease: LeaseKeeper,
    private readonly opts: ForwarderOptions = {},
  ) {}

  publish(e: ExaEvent): void {
    if (SERVER_ORIGINATED.has(e.type)) return;
    if (!this.mergeDelta(e)) {
      this.queue.push({
        type: e.type,
        v: e.v,
        data: structuredClone(e.data),
        time: e.time,
        sessionId: e.sessionId,
      });
    }
    this.schedule();
  }

  /** Called by MirrorStore for storage_mode=server. */
  mirrorMessage(info: MessageInfo): void {
    const cur = this.persist.get(info.id);
    if (cur) cur.info = structuredClone(info);
    else this.persist.set(info.id, { info: structuredClone(info), parts: new Map() });
    this.schedule();
  }

  mirrorParts(parts: Part[]): void {
    for (const p of parts) {
      const cur = this.persist.get(p.messageId);
      if (cur) cur.parts.set(p.id, structuredClone(p));
    }
    this.schedule();
  }

  async flush(): Promise<void> {
    if (this.sending) {
      await this.sending;
      if (!this.hasPending()) return;
    }
    if (this.lease.lost || !this.hasPending()) return;
    this.sending = this.send(this.takeBatch());
    await this.sending;
    if (this.hasPending()) this.schedule();
  }

  /** Append a text delta to the previous queued delta for the same part, if there is one. */
  private mergeDelta(e: ExaEvent): boolean {
    const last = this.queue[this.queue.length - 1];
    if (e.type !== "message.part.delta" || last?.type !== "message.part.delta") return false;
    if (last.sessionId !== e.sessionId) return false;
    const lastData = last.data as DeltaData;
    const data = e.data as DeltaData;
    if (lastData.partId !== data.partId) return false;
    lastData.delta += data.delta;
    return true;
  }

  private hasPending(): boolean {
    return this.queue.length > 0 || this.persist.size > 0;
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  private takeBatch(): Batch {
    const events = this.queue.splice(0, MAX_EVENTS_PER_BATCH);
    const persist = [...this.persist.values()].map((p) => ({
      info: p.info,
      parts: [...p.parts.values()],
    }));
    this.persist.clear();
    return { events, persist };
  }

  private async send({ events, persist }: Batch): Promise<void> {
    try {
      await this.api.ingest(this.rootSessionId, {
        fencing: this.lease.fencing,
        events: events.map((e) => this.toWireEvent(e)),
        ...(persist.length ? { persist } : {}),
      });
      this.failures = 0;
    } catch (e) {
      this.failures++;
      // keep content mirrors for retry; drop live events (they're only for viewers)
      this.requeueMirrors(persist);
      this.opts.onError?.(e);
    } finally {
      this.sending = null;
    }
  }

  /** Events for the root session omit sessionId; child-session events are tagged. */
  private toWireEvent(e: QueuedEvent) {
    return {
      type: e.type,
      v: e.v,
      data: e.data,
      time: e.time,
      ...(e.sessionId !== this.rootSessionId ? { sessionId: e.sessionId } : {}),
    };
  }

  /** Newer mirrors queued while sending win over the failed batch. */
  private requeueMirrors(persist: PersistEntry[]): void {
    for (const p of persist) {
      if (this.persist.has(p.info.id)) continue;
      this.persist.set(p.info.id, {
        info: p.info,
        parts: new Map(p.parts.map((x) => [x.id, x])),
      });
    }
  }
}
