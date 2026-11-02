// In-memory SessionStore: storage_mode "none" (content lives only while the runtime does)
// and the reference implementation the other stores are tested against.

import type { MessageInfo, MessageWithParts, Part, SessionInfo } from "@exa/protocol";
import type { SessionStore } from "../models/ports.model.ts";

export class MemoryStore implements SessionStore {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly messagesBySession = new Map<string, Map<string, MessageWithParts>>();

  async createSession(info: SessionInfo): Promise<void> {
    this.sessions.set(info.id, structuredClone(info));
    this.messagesBySession.set(info.id, new Map());
  }

  async getSession(id: string): Promise<SessionInfo | null> {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }

  async updateSession(id: string, patch: Partial<SessionInfo>): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    Object.assign(s, structuredClone(patch));
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()]
      .map((s) => structuredClone(s))
      .sort((a, b) => b.time.updated - a.time.updated);
  }

  async messages(sessionId: string): Promise<MessageWithParts[]> {
    const m = this.messagesBySession.get(sessionId);
    if (!m) return [];
    return [...m.values()].map((x) => structuredClone(x));
  }

  async putMessage(info: MessageInfo): Promise<void> {
    let m = this.messagesBySession.get(info.sessionId);
    if (!m) {
      m = new Map();
      this.messagesBySession.set(info.sessionId, m);
    }
    const cur = m.get(info.id);
    if (cur) cur.info = structuredClone(info);
    else m.set(info.id, { info: structuredClone(info), parts: [] });
  }

  async putParts(parts: Part[]): Promise<void> {
    for (const p of parts) {
      const msg = this.messagesBySession.get(p.sessionId)?.get(p.messageId);
      if (!msg) continue;
      const i = msg.parts.findIndex((x) => x.id === p.id);
      if (i === -1) msg.parts.push(structuredClone(p));
      else msg.parts[i] = structuredClone(p);
    }
  }

  async deleteMessages(sessionId: string, ids: string[]): Promise<void> {
    const m = this.messagesBySession.get(sessionId);
    if (!m) return;
    for (const id of ids) m.delete(id);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.messagesBySession.delete(sessionId);
  }
}
