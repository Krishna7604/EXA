// Route table: bring-your-own provider keys.
import type { KeyController } from "../controllers/key.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function keyRoutes(c: KeyController): RouteDef[] {
  return [
    { method: "GET", path: "/v1/keys", handler: c.list },
    { method: "PUT", path: "/v1/keys", handler: c.put },
    { method: "DELETE", path: "/v1/keys/:id", handler: c.revoke },
  ];
}
