#!/usr/bin/env bun
// `bun scripts/db-inspect.ts [SQL]` — read-only look at the server database. With SQL, prints the
// result as a table; without, lists tables with row counts and sessions by storage mode.
// Uses DATABASE_URL (Postgres) if set, else a throwaway copy of the PGlite data folder, so it is
// safe to run while the server is up.

import { cp, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteDb, type Queryable } from "../packages/store/src/db/db.ts";

// ---------- constants ----------
const MAX_ROWS = 40;
const MAX_CELL_CHARS = 60;
const TABLE_NAME_WIDTH = 24;
const COUNT_WIDTH = 6;
/** Partition children (`*_default`, `*_YYYYMM`) are folded into their parent table. */
const PARTITION_SUFFIX = /_[0-9]{6}$/;

const url = process.env.DATABASE_URL;
const dataDir = resolveDataDir();
const query = process.argv.slice(2).join(" ").trim();

// ---------- main ----------
if (query) {
  const rows = await withDb((q) => q.query(query));
  console.log(formatTable(rows));
} else {
  const mode = url ? `postgres (${new URL(url).host})` : `pglite snapshot of ${dataDir}`;
  console.log(`\n  exa db · ${mode}\n`);
  await withDb(async (q) => {
    await printTableCounts(q);
    await printSessionsByStorage(q);
    console.log("");
  });
}

// ---------- helpers ----------
function resolveDataDir(): string {
  if (process.env.EXA_DB_DIR !== undefined) return process.env.EXA_DB_DIR;
  const serverDir = process.env.EXA_DATA_DIR ?? join(homedir(), ".exa", "server");
  return join(serverDir, "pg");
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS - 3)}…` : s;
}

function formatTable(rows: Record<string, unknown>[], max = MAX_ROWS): string {
  if (!rows.length) return "  (no rows)";
  const cols = Object.keys(rows[0]);
  const shown = rows.slice(0, max);
  const widths = cols.map((c) => Math.max(c.length, ...shown.map((r) => formatCell(r[c]).length)));
  const line = (vals: string[]) => `  ${vals.map((v, i) => v.padEnd(widths[i])).join("  ")}`;
  const out = [line(cols), `  ${widths.map((n) => "─".repeat(n)).join("  ")}`];
  for (const r of shown) out.push(line(cols.map((c) => formatCell(r[c]))));
  if (rows.length > max) out.push(`  … ${rows.length - max} more`);
  return out.join("\n");
}

async function printTableCounts(q: Queryable): Promise<void> {
  const tables = await q.query<{ c: string }>(
    `select c.relname as c from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind in ('r','p') order by 1`,
  );
  console.log("  tables");
  for (const { c } of tables) {
    if (c.endsWith("_default") || PARTITION_SUFFIX.test(c)) continue;
    const n = await q.query<{ n: number }>(`select count(*)::int as n from "${c}"`);
    console.log(`    ${c.padEnd(TABLE_NAME_WIDTH)} ${String(n[0].n).padStart(COUNT_WIDTH)} rows`);
  }
}

async function printSessionsByStorage(q: Queryable): Promise<void> {
  const rows = await q.query<{ storage_mode: string; n: number }>(
    `select storage_mode, count(*)::int as n from sessions group by 1 order by 1`,
  );
  if (!rows.length) return;
  console.log("\n  sessions by storage_mode");
  for (const r of rows)
    console.log(
      `    ${String(r.storage_mode).padEnd(TABLE_NAME_WIDTH)} ${String(r.n).padStart(COUNT_WIDTH)}`,
    );
}

/** Run `fn` against Postgres (DATABASE_URL) or a temporary copy of the PGlite folder. */
async function withDb<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  if (url) return withPostgres(url, fn);
  if (dataDir === "memory") throw new Error("EXA_DB_DIR=memory has nothing on disk to inspect");
  return withPgliteSnapshot(dataDir, fn);
}

async function withPostgres<T>(dbUrl: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const { SQL } = await import("bun");
  const sql = new SQL({ url: dbUrl, max: 1 });
  try {
    return await fn({
      query: async (q: string, p: unknown[] = []) =>
        (await sql.unsafe(q, p)) as Record<string, unknown>[],
    });
  } finally {
    await sql.close();
  }
}

/** Copy first: PGlite allows one process per data folder, and the server may hold it. */
async function withPgliteSnapshot<T>(dir: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const snap = await mkdtemp(join(tmpdir(), "exa-dbq-"));
  const copy = join(snap, "pg");
  try {
    await cp(dir, copy, { recursive: true });
    const db = await PgliteDb.open(copy);
    try {
      return await fn(db);
    } finally {
      await db.close();
    }
  } finally {
    await rm(snap, { recursive: true, force: true });
  }
}
