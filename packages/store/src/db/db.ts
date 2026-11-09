// Database access. Two backends behind one tiny interface:
//  - Postgres via Bun's native client (production; DATABASE_URL)
//  - PGlite, embedded Postgres in WASM (tests, dev, single-node self-host; EXA_DB_DIR)
//
// Tenant isolation: every tenant-scoped query runs inside `withTenant`, which opens a
// transaction, sets `exa.tenant_id` and switches to the non-owner `exa_app` role so Postgres
// row-level security filters every row. System queries (auth lookups) run as the owner.
//
// Repositories use the Drizzle ORM through `orm`. Each transaction handle carries its own
// Drizzle instance bound to that transaction's connection, so ORM queries inside `withTenant`
// see the tenant setting and the app role. `query` stays as the raw-SQL escape hatch
// (migrations, partition maintenance, tests).
import { mkdir } from "node:fs/promises";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

// ---------- constants ----------
const TENANT_SETUP = `select set_config('exa.tenant_id', $1, true)`;
const USE_APP_ROLE = `set local role exa_app`;
const DEFAULT_POOL_MAX = 20;
const POOL_IDLE_TIMEOUT_S = 30;
const DATA_DIR_MODE = 0o700;

// ---------- types ----------
/** Drizzle database (or transaction) over either driver. Use the query builder, not `execute`. */
export type Orm = PgDatabase<PgQueryResultHKT>;

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** One transaction: raw SQL and the ORM, both on the same connection. */
export interface DbTx extends Queryable {
  readonly orm: Orm;
}

export interface Db extends Queryable {
  /** ORM outside any transaction, as the owner role (no tenant scope). */
  readonly orm: Orm;
  tx<T>(fn: (q: DbTx) => Promise<T>): Promise<T>;
  withTenant<T>(tenantId: string, fn: (q: DbTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "postgres" | "pglite";
}

// ---------- pglite ----------
export class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  private constructor(
    private readonly pg: any,
    private readonly bind: (client: unknown) => Orm,
    readonly orm: Orm,
  ) {}

  static async open(dataDir?: string): Promise<PgliteDb> {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    if (dataDir) await mkdir(dataDir, { recursive: true, mode: DATA_DIR_MODE });
    const pg = dataDir ? new PGlite(dataDir) : new PGlite();
    await pg.waitReady;
    const bind = (client: unknown) => drizzle(client as any) as unknown as Orm;
    return new PgliteDb(pg, bind, bind(pg));
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pg.query(sql, params);
    return r.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async tx<T>(fn: (q: DbTx) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx: any) =>
      fn({
        orm: this.bind(tx),
        query: async <R>(sql: string, params: unknown[] = []) =>
          (await tx.query(sql, params)).rows as R[],
      }),
    );
  }

  async withTenant<T>(tenantId: string, fn: (q: DbTx) => Promise<T>): Promise<T> {
    return this.tx((q) => runAsTenant(q, tenantId, fn));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

// ---------- postgres ----------
export class PostgresDb implements Db {
  readonly kind = "postgres" as const;
  private constructor(
    private readonly sql: any,
    private readonly bind: (client: unknown) => Orm,
    readonly orm: Orm,
  ) {}

  static async open(url: string, opts: { max?: number } = {}): Promise<PostgresDb> {
    const { SQL } = await import("bun");
    const { drizzle } = await import("drizzle-orm/bun-sql");
    const sql = new SQL({
      url,
      max: opts.max ?? DEFAULT_POOL_MAX,
      idleTimeout: POOL_IDLE_TIMEOUT_S,
    });
    await sql.unsafe("select 1");
    const bind = (client: unknown) => drizzle({ client: client as any }) as unknown as Orm;
    return new PostgresDb(sql, bind, bind(sql));
  }

  async query<T>(q: string, params: unknown[] = []): Promise<T[]> {
    return (await this.sql.unsafe(q, params)) as T[];
  }

  async exec(q: string): Promise<void> {
    await this.sql.unsafe(q);
  }

  async tx<T>(fn: (q: DbTx) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx: any) =>
      fn({
        orm: this.bind(tx),
        query: async <R>(s: string, p: unknown[] = []) => (await tx.unsafe(s, p)) as R[],
      }),
    );
  }

  async withTenant<T>(tenantId: string, fn: (q: DbTx) => Promise<T>): Promise<T> {
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
async function runAsTenant<T>(q: DbTx, tenantId: string, fn: (q: DbTx) => Promise<T>): Promise<T> {
  await q.query(TENANT_SETUP, [tenantId]);
  await q.query(USE_APP_ROLE);
  return fn(q);
}
