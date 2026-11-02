// Route table: model gateway and policy endpoints used by client loops.
import type { ModelController } from "../controllers/model.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function modelRoutes(c: ModelController): RouteDef[] {
  return [
    { method: "POST", path: "/v1/model/stream", handler: c.stream },
    { method: "GET", path: "/v1/models", handler: c.catalog },
    { method: "GET", path: "/v1/policy/key", handler: c.policyKey, auth: false },
    { method: "GET", path: "/v1/policy", handler: c.policy },
    { method: "POST", path: "/v1/authorize", handler: c.authorize },
  ];
}
