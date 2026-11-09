// The full API route table: builds one controller per service and concatenates every
// route table in registration order.
import type { Services } from "../container.ts";
import { AccountController } from "../controllers/account.controller.ts";
import { AuthController } from "../controllers/auth.controller.ts";
import { ClientSyncController } from "../controllers/client-sync.controller.ts";
import { ConnectorController } from "../controllers/connector.controller.ts";
import { ExtensionController } from "../controllers/extension.controller.ts";
import { HealthController } from "../controllers/health.controller.ts";
import { KeyController } from "../controllers/key.controller.ts";
import { MemoryController } from "../controllers/memory.controller.ts";
import { ModelController } from "../controllers/model.controller.ts";
import { SessionController } from "../controllers/session.controller.ts";
import { SettingsController } from "../controllers/settings.controller.ts";
import { TaskController } from "../controllers/task.controller.ts";
import { UsageController } from "../controllers/usage.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";
import { accountRoutes } from "./account.routes.ts";
import { authRoutes } from "./auth.routes.ts";
import { connectorRoutes } from "./connector.routes.ts";
import { extensionRoutes } from "./extension.routes.ts";
import { healthRoutes } from "./health.routes.ts";
import { keyRoutes } from "./key.routes.ts";
import { memoryRoutes } from "./memory.routes.ts";
import { modelRoutes } from "./model.routes.ts";
import { sessionRoutes } from "./session.routes.ts";
import { settingsRoutes } from "./settings.routes.ts";
import { taskRoutes } from "./task.routes.ts";
import { usageRoutes } from "./usage.routes.ts";

// ---------- routes ----------
export function apiRoutes(s: Services): RouteDef[] {
  const maxBody = s.cfg.maxBodyBytes;
  return [
    ...healthRoutes(new HealthController()),
    ...authRoutes(new AuthController(s.authService)),
    ...accountRoutes(new AccountController(s.accountService)),
    ...modelRoutes(new ModelController(s.modelService, maxBody)),
    ...sessionRoutes(
      new SessionController(s.sessionService, s.bus, maxBody),
      new ClientSyncController(s.sessionService, s.clientSyncService, maxBody),
    ),
    ...settingsRoutes(new SettingsController(s.settingsService)),
    ...keyRoutes(new KeyController(s.keyService)),
    ...usageRoutes(new UsageController(s.usageService)),
    ...extensionRoutes(new ExtensionController(s.extensionService)),
    ...taskRoutes(new TaskController(s.taskService)),
    ...memoryRoutes(new MemoryController(s.memoryService)),
    ...connectorRoutes(new ConnectorController(s.connectorService)),
  ];
}
