// Route table: liveness probe.
import type { HealthController } from "../controllers/health.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function healthRoutes(c: HealthController): RouteDef[] {
  return [{ method: "GET", path: "/healthz", handler: c.health, auth: false }];
}
