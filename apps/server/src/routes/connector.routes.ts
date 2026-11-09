// Route table: connectors (remote MCP servers for the server-side agent).
import type { ConnectorController } from "../controllers/connector.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function connectorRoutes(c: ConnectorController): RouteDef[] {
  return [
    { method: "GET", path: "/v1/connectors", handler: c.list },
    { method: "POST", path: "/v1/connectors", handler: c.create },
    { method: "PATCH", path: "/v1/connectors/:id", handler: c.update },
    { method: "DELETE", path: "/v1/connectors/:id", handler: c.remove },
    { method: "POST", path: "/v1/connectors/:id/test", handler: c.test },
  ];
}
