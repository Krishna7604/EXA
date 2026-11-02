// Database access. Two backends behind one tiny interface:
//  - Postgres via Bun's native client (production; DATABASE_URL)
//  - PGlite, embedded Postgres in WASM (tests, dev, single-node self-host; EXA_DB_DIR)
//
// Tenant isolation: every tenant-scoped query runs inside `withTenant`, which opens a
// transaction, sets `exa.tenant_id` and switches to the non-owner `exa_app` role so Postgres
// row-level security filters every row. System queries (auth lookups) run as the owner.
import { mkdir } from "node:fs/promises";

// ---------- constants ----------
const TENANT_SETUP = `select set_config('exa.tenant_id', $1, true)`;
const USE_APP_ROLE = `set local role exa_app`;
const DEFAULT_POOL_MAX = 20;
const POOL_IDLE_TIMEOUT_S = 30;
const DATA_DIR_MODE = 0o700;

// ---------- types ----------
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  withTenant<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "postgres" | "pglite";
}

// ---------- pglite ----------
export class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  private constructor(private readonly pg: any) {}

  static async open(dataDir?: string): Promise<PgliteDb> {
    const { PGlite } = await import("@electric-sql/pglite");
    if (dataDir) await mkdir(dataDir, { recursive: true, mode: DATA_DIR_MODE });
    const pg = dataDir ? new PGlite(dataDir) : new PGlite();
    await pg.waitReady;
    return new PgliteDb(pg);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pg.query(sql, params);
    return r.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx: any) =>
      fn({
        query: async <R>(sql: string, params: unknown[] = []) =>
          (await tx.query(sql, params)).rows as R[],
      }),
    );
  }

  async withTenant<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.tx((q) => runAsTenant(q, tenantId, fn));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

// ---------- postgres ----------
export class PostgresDb implements Db {
  readonly kind = "postgres" as const;
  private constructor(private readonly sql: any) {}

  static async open(url: string, opts: { max?: number } = {}): Promise<PostgresDb> {
    const { SQL } = await import("bun");
    const sql = new SQL({
      url,
      max: opts.max ?? DEFAULT_POOL_MAX,
      idleTimeout: POOL_IDLE_TIMEOUT_S,
    });
    await sql.unsafe("select 1");
    return new PostgresDb(sql);
  }

  async query<T>(q: string, params: unknown[] = []): Promise<T[]> {
    return (await this.sql.unsafe(q, params)) as T[];
  }

  async exec(q: string): Promise<void> {
    await this.sql.unsafe(q);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx: any) =>
      fn({ query: async <R>(s: string, p: unknown[] = []) => (await tx.unsafe(s, p)) as R[] }),
    );
  }

  async withTenant<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.tx((q) => runAsTenant(q, tenantId, fn));
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

// ---------- open ----------
/** Postgres when a URL is given, otherwise embedded PGlite (in memory, or under dataDir). */
export async function openDb(
  opts: { url?: string; dataDir?: string } = {},
): Promise<Db & { exec(sql: string): Promise<void> }> {
  if (opts.url) return PostgresDb.open(opts.url);
  return PgliteDb.open(opts.dataDir);
}

// ---------- helpers ----------
/** Inside a transaction: scope RLS to the tenant and drop to the non-owner app role. */
async function runAsTenant<T>(
  q: Queryable,
  tenantId: string,
  fn: (q: Queryable) => Promise<T>,
): Promise<T> {
  await q.query(TENANT_SETUP, [tenantId]);
  await q.query(USE_APP_ROLE);
  return fn(q);
}
