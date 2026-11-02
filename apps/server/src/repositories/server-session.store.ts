// SessionStore for the SERVER loop: metadata always in Postgres; content in Postgres when
// storage_mode = 'server', otherwise in a bounded in-memory cache that disappears with the runtime.
import { MemoryStore, type SessionStore } from "@exa/core";
import type { MessageInfo, MessageWithParts, Part, SessionInfo, StorageMode } from "@exa/protocol";
import type { SessionRepo } from "./session.repository.ts";

// ---------- constants ----------
const DEFAULT_MAX_MEMORY_SESSIONS = 500;

// ---------- server session store ----------
/**
 * SessionStore used by the SERVER loop for one tenant. Metadata → Postgres always.
 * Content → Postgres when storage_mode = 'server', else an in-memory cache (LRU-bounded).
 */
export class ServerSessionStore implements SessionStore {
  private readonly mem = new MemoryStore();
  private readonly modes = new Map<string, StorageMode>();
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly repo: SessionRepo,
    private readonly tenantId: string,
    private readonly maxMemorySessions = DEFAULT_MAX_MEMORY_SESSIONS,
  ) {}

  async createSession(info: SessionInfo): Promise<void> {
    await this.repo.create(info);
    this.modes.set(info.id, info.storageMode);
    if (info.storageMode !== "server") {
      await this.mem.createSession(info);
      this.touch(info.id);
    }
  }

  async getSession(id: string): Promise<SessionInfo | null> {
    const s = await this.repo.get(this.tenantId, id);
    if (s) this.modes.set(id, s.storageMode);
    return s;
  }

  async updateSession(id: string, patch: Partial<SessionInfo>): Promise<void> {
    await this.repo.update(this.tenantId, id, patch);
  }

  async messages(sessionId: string): Promise<MessageWithParts[]> {
    if ((await this.mode(sessionId)) === "server")
      return this.repo.messages(this.tenantId, sessionId);
    this.touch(sessionId);
    return this.mem.messages(sessionId);
  }

  async putMessage(info: MessageInfo): Promise<void> {
    if ((await this.mode(info.sessionId)) === "server")
      return this.repo.putMessage(this.tenantId, info);
    this.touch(info.sessionId);
    return this.mem.putMessage(info);
  }

  async putParts(parts: Part[]): Promise<void> {
    if (!parts.length) return;
    if ((await this.mode(parts[0].sessionId)) === "server")
      return this.repo.putParts(this.tenantId, parts);
    return this.mem.putParts(parts);
  }

  async deleteMessages(sessionId: string, ids: string[]): Promise<void> {
    if ((await this.mode(sessionId)) === "server")
      return this.repo.deleteMessages(this.tenantId, sessionId, ids);
    return this.mem.deleteMessages(sessionId, ids);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.repo.delete(this.tenantId, sessionId);
    await this.mem.deleteSession(sessionId);
    this.modes.delete(sessionId);
    this.touched.delete(sessionId);
  }

  /** Storage mode of a session, looked up once and cached. */
  private async mode(sessionId: string): Promise<StorageMode> {
    let m = this.modes.get(sessionId);
    if (!m) {
      const s = await this.repo.get(this.tenantId, sessionId);
      m = s?.storageMode ?? "none";
      this.modes.set(sessionId, m);
    }
    return m;
  }

  /** Mark a cached session as recently used; evict the least recently used over the cap. */
  private touch(id: string): void {
    this.touched.set(id, Date.now());
    if (this.touched.size > this.maxMemorySessions) this.evictOldest();
  }

  private evictOldest(): void {
    const oldest = [...this.touched.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, this.touched.size - this.maxMemorySessions);
    for (const [sid] of oldest) {
      this.touched.delete(sid);
      void this.mem.deleteSession(sid);
    }
  }
}
