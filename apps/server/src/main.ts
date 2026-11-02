// exa server entrypoint: `bun run apps/server/src/main.ts`. Boots services, serves HTTP,
// schedules maintenance and shuts down cleanly on SIGINT/SIGTERM.

import { createApp } from "./app.ts";
import { loadConfig, type ServerConfig } from "./config/env.config.ts";
import { createServices, type Services } from "./container.ts";
import { scheduleMaintenance } from "./jobs/maintenance.job.ts";

// ---------- constants ----------
/** Seconds; SSE + model streams are long-lived, and their heartbeats keep them under this. */
const IDLE_TIMEOUT_SEC = 255;
const MASTER_KEY_HINT =
  "bun -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"";

// ---------- main ----------
const cfg = loadConfig();
const services = await createServices(cfg);
const app = createApp(services);

const server = Bun.serve({
  port: cfg.port,
  hostname: cfg.host,
  idleTimeout: IDLE_TIMEOUT_SEC,
  maxRequestBodySize: cfg.maxBodyBytes,
  fetch: (req, srv) => app.fetch(req, srv),
});

// Maintenance: idle runtimes, partitions, retention, expired approvals/device codes.
const stopMaintenance = scheduleMaintenance(services);

logStartup(cfg, services, server.url);

const shutdown = async () => {
  stopMaintenance();
  server.stop();
  await services.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------- helpers ----------
function logStartup(config: ServerConfig, s: Services, url: URL): void {
  console.log(`exa server listening on ${url} (db: ${describeDb(config)})`);
  if (config.devAuth) console.log("  dev auth ENABLED (EXA_DEV_AUTH=1) — do not use in production");
  if (!s.vault)
    console.log(`  BYOK disabled: set EXA_MASTER_KEY (generate with: ${MASTER_KEY_HINT})`);
  const poolKeys = Object.keys(config.pool).filter((k) => !/REGION/.test(k));
  const poolSummary = poolKeys.length
    ? poolKeys.join(", ")
    : "none (the exa model needs at least one)";
  console.log(`  platform pool keys: ${poolSummary}`);
}

function describeDb(config: ServerConfig): string {
  if (config.databaseUrl) return "postgres";
  if (config.dbDir) return `pglite ${config.dbDir}`;
  return "in-memory";
}
