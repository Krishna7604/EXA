// Memory port backed by the exa server's memory API: a logged-in CLI chat shares the user's
// long-term memory and stored-chat search with their web chats. Local mode has no memory.

import type { MemoryPort } from "@exa/core";
import { ApiError, type ExaApi } from "../services/api.service.ts";

// ---------- constants ----------
const HTTP_NOT_FOUND = 404;

// ---------- remote memory ----------
/** The server links no source chat for these writes (its API takes topic + content only). */
export function remoteMemory(api: ExaApi): MemoryPort {
  return {
    list: (limit) => api.memories(limit),
    save: ({ id, topic, content }) =>
      id === undefined
        ? api.createMemory({ topic, content })
        : api.updateMemory(id, { topic, content }),
    forget: (id) => forgetRemote(api, id),
    search: (query, limit) => api.searchMemories(query, limit),
    searchChats: (query, limit) => api.searchChats(query, limit),
  };
}

// ---------- helpers ----------
/** A 404 means "no such memory" (false); anything else is a real failure. */
async function forgetRemote(api: ExaApi, id: string): Promise<boolean> {
  try {
    await api.deleteMemory(id);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === HTTP_NOT_FOUND) return false;
    throw e;
  }
}
