// storage_mode=server on a client loop: content in memory locally, mirrored to the server.

import { MemoryStore, type SessionStore } from "@exa/core";
import type { MessageInfo, MessageWithParts, Part, SessionInfo } from "@exa/protocol";
import type { EventForwarder } from "./event-forwarder.ts";

// ---------- mirror store ----------
export class MirrorStore implements SessionStore {
  readonly mem = new MemoryStore();

  constructor(private readonly fwd: EventForwarder) {}

  createSession(i: SessionInfo) {
    return this.mem.createSession(i);
  }
  getSession(id: string) {
    return this.mem.getSession(id);
  }
  updateSession(id: string, p: Partial<SessionInfo>) {
    return this.mem.updateSession(id, p);
  }
  messages(id: string) {
    return this.mem.messages(id);
  }
  async putMessage(info: MessageInfo) {
    await this.mem.putMessage(info);
    this.fwd.mirrorMessage(info);
  }
  async putParts(parts: Part[]) {
    await this.mem.putParts(parts);
    this.fwd.mirrorParts(parts);
  }
  deleteMessages(id: string, ids: string[]) {
    return this.mem.deleteMessages(id, ids);
  }
  deleteSession(id: string) {
    return this.mem.deleteSession(id);
  }
  /** Seed from server history on resume. */
  async seed(info: SessionInfo, messages: MessageWithParts[]) {
    await this.mem.createSession(info);
    for (const m of messages) {
      await this.mem.putMessage(m.info);
      await this.mem.putParts(m.parts);
    }
  }
}
