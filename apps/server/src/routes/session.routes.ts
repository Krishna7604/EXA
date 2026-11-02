// Route table: sessions (CRUD, server-loop controls, approvals, live events) and the
// client-loop lease + event ingest.
import type { ClientSyncController } from "../controllers/client-sync.controller.ts";
import type { SessionController } from "../controllers/session.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function sessionRoutes(c: SessionController, sync: ClientSyncController): RouteDef[] {
  return [
    { method: "POST", path: "/v1/sessions", handler: c.create },
    { method: "GET", path: "/v1/sessions", handler: c.list },
    { method: "GET", path: "/v1/sessions/:id", handler: c.get },
    { method: "PATCH", path: "/v1/sessions/:id", handler: c.update },
    { method: "DELETE", path: "/v1/sessions/:id", handler: c.forget },
    { method: "POST", path: "/v1/sessions/:id/prompt", handler: c.prompt },
    { method: "POST", path: "/v1/sessions/:id/abort", handler: c.abort },
    { method: "POST", path: "/v1/sessions/:id/revert", handler: c.revert },
    { method: "POST", path: "/v1/sessions/:id/unrevert", handler: c.unrevert },
    { method: "POST", path: "/v1/sessions/:id/compact", handler: c.compact },
    { method: "POST", path: "/v1/sessions/:id/permissions/:reqId", handler: c.replyPermission },
    { method: "GET", path: "/v1/sessions/:id/events", handler: c.events },
    { method: "POST", path: "/v1/sessions/:id/lease", handler: sync.lease },
    { method: "POST", path: "/v1/sessions/:id/ingest", handler: sync.ingest },
  ];
}
