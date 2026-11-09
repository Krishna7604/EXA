// Route table: long-term memory and chat history search.
import type { MemoryController } from "../controllers/memory.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function memoryRoutes(c: MemoryController): RouteDef[] {
  return [
    { method: "GET", path: "/v1/memories", handler: c.list },
    { method: "POST", path: "/v1/memories", handler: c.create },
    { method: "PUT", path: "/v1/memories/:id", handler: c.update },
    { method: "DELETE", path: "/v1/memories/:id", handler: c.remove },
    { method: "GET", path: "/v1/search", handler: c.searchChats },
  ];
}
