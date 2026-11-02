// Route table: usage summary and audit trail.
import type { UsageController } from "../controllers/usage.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function usageRoutes(c: UsageController): RouteDef[] {
  return [
    { method: "GET", path: "/v1/usage", handler: c.summary },
    { method: "GET", path: "/v1/audit", handler: c.audit },
  ];
}
