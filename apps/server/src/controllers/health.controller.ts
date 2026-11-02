// Liveness probe: `GET /healthz` with the server version.
import { json } from "../helpers/http.helper.ts";

// ---------- constants ----------
const SERVER_VERSION = "2.0.0-alpha.0";

// ---------- health controller ----------
export class HealthController {
  health = (): Response => json({ ok: true, version: SERVER_VERSION });
}
