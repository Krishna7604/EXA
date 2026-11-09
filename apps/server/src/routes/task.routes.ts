// Route table: scheduled tasks, their manual runs and run history.
import type { TaskController } from "../controllers/task.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function taskRoutes(c: TaskController): RouteDef[] {
  return [
    { method: "GET", path: "/v1/tasks", handler: c.list },
    { method: "POST", path: "/v1/tasks", handler: c.create },
    { method: "GET", path: "/v1/tasks/:id", handler: c.get },
    { method: "PATCH", path: "/v1/tasks/:id", handler: c.update },
    { method: "DELETE", path: "/v1/tasks/:id", handler: c.remove },
    { method: "POST", path: "/v1/tasks/:id/run", handler: c.run },
    { method: "GET", path: "/v1/tasks/:id/runs", handler: c.runs },
  ];
}
