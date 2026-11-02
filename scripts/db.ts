// `bun run db` — open the dev server's embedded database (PGlite) on a normal Postgres port so
// any client (TablePlus, DBeaver, pgAdmin, psql) can browse it. Stop the exa server first:
// PGlite allows one process per data folder.
//   EXA_DATA_DIR=...  (default ~/.exa/server)   EXA_DB_PORT=5433

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

// ---------- constants ----------
const DEFAULT_DB_PORT = 5433;
const DEFAULT_SERVER_PORT = 4317;
const MAX_CONNECTIONS = 8;
const HOST = "127.0.0.1";
const COUNTS_SQL = `select 'tenants' as t, count(*)::int as n from tenants union all select 'users', count(*)::int from users
   union all select 'sessions', count(*)::int from sessions union all select 'messages', count(*)::int from messages`;

const dataDir = join(process.env.EXA_DATA_DIR ?? join(homedir(), ".exa", "server"), "pg");
const port = Number(process.env.EXA_DB_PORT ?? DEFAULT_DB_PORT);
const serverPort = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);

// ---------- main ----------
if (!existsSync(dataDir)) {
  console.error(
    `No database at ${dataDir} — start the server once with \`bun run dev\` to create it.`,
  );
  process.exit(1);
}
if (await isServerRunning()) {
  console.error(
    `The exa server is running on :${serverPort}. Stop it first (Ctrl+C) — the embedded database can only be opened by one process.`,
  );
  process.exit(1);
}

const db = new PGlite(dataDir);
await db.waitReady;
const server = new PGLiteSocketServer({ db, port, host: HOST, maxConnections: MAX_CONNECTIONS });
await server.start();
await printSummary();

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// ---------- helpers ----------
async function isServerRunning(): Promise<boolean> {
  return fetch(`http://${HOST}:${serverPort}/healthz`).then(
    () => true,
    () => false,
  );
}

async function printSummary(): Promise<void> {
  const counts = await db.query<{ t: string; n: number }>(COUNTS_SQL);
  console.log(
    `exa database open at postgres://postgres@${HOST}:${port}/postgres  (no password, local only)`,
  );
  console.log(`  data: ${dataDir}`);
  console.log(`  ${counts.rows.map((r) => `${r.t}: ${r.n}`).join(" · ")}`);
  console.log(
    `  You connect as superuser, so you see ALL organizations (row-level security doesn't apply).`,
  );
  console.log(`  Ctrl+C to close, then start the server again with \`bun run dev\`.`);
}

async function stop(): Promise<void> {
  await server.stop();
  await db.close();
  process.exit(0);
}
