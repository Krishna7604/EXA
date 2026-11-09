import { beforeAll, describe, expect, test } from "bun:test";
import { newId } from "@exa/protocol";
import { eq } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as store from "../index.ts";
import { migrate, PgliteDb, PostgresDb } from "../index.ts";

let db: PgliteDb | PostgresDb;

/** Every Drizzle table exported by the package. */
const TABLES = (Object.values(store) as unknown[]).filter(
  (v): v is PgTable => typeof v === "object" && v !== null && isPgTable(v),
);

beforeAll(async () => {
  const url = process.env.EXA_TEST_DATABASE_URL;
  if (url) {
    db = await PostgresDb.open(url);
    await db.exec(
      "drop schema public cascade; create schema public; grant usage on schema public to public;",
    );
  } else db = await PgliteDb.open();
  await migrate(db);
});

describe("drizzle tables mirror the SQL migrations", () => {
  test("every table is defined, with exactly the migrated columns", async () => {
    expect(TABLES.length).toBeGreaterThan(25);
    for (const t of TABLES) {
      const cfg = getTableConfig(t);
      const rows = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = $1`,
        [cfg.name],
      );
      const inDb = rows.map((r) => r.column_name).sort();
      const inOrm = cfg.columns.map((c) => c.name).sort();
      expect({ table: cfg.name, columns: inOrm }).toEqual({ table: cfg.name, columns: inDb });
    }
  });

  test("every tenant table has a Drizzle definition", () => {
    const defined = new Set(TABLES.map((t) => getTableConfig(t).name));
    for (const t of store.TENANT_TABLES)
      expect({ t, defined: defined.has(t) }).toEqual({ t, defined: true });
  });
});

describe("orm inside withTenant", () => {
  test("ORM writes and reads are scoped by row-level security", async () => {
    const a = newId();
    const b = newId();
    await db.orm.insert(store.tenants).values([
      { id: a, slug: `a-${a.slice(0, 8)}`, name: "A" },
      { id: b, slug: `b-${b.slice(0, 8)}`, name: "B" },
    ]);
    const memory = { tenantId: a, userId: newId(), topic: "diet", content: "vegetarian" };
    await db.withTenant(a, (q) => q.orm.insert(store.memories).values({ id: newId(), ...memory }));
    const seenByA = await db.withTenant(a, (q) =>
      q.orm.select().from(store.memories).where(eq(store.memories.topic, "diet")),
    );
    const seenByB = await db.withTenant(b, (q) => q.orm.select().from(store.memories));
    expect(seenByA.length).toBe(1);
    expect(seenByA[0].createdAt).toBeInstanceOf(Date);
    expect(seenByB.length).toBe(0);
    // writing a row for another tenant is refused by the policy
    await expect(
      db.withTenant(b, (q) => q.orm.insert(store.memories).values({ id: newId(), ...memory })),
    ).rejects.toThrow();
  });

  test("jsonb, arrays and bytea round-trip as values", async () => {
    const tenantId = newId();
    await db.orm
      .insert(store.tenants)
      .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: "T" });
    const rule = { tenantId, scope: "tenant", scopeId: tenantId, key: "k", value: { a: [1, "x"] } };
    await db.withTenant(tenantId, (q) => q.orm.insert(store.settings).values(rule));
    const raw = await db.withTenant(tenantId, (q) =>
      q.query<{ t: string }>(`select jsonb_typeof(value) as t from settings where key = 'k'`),
    );
    expect(raw[0].t).toBe("object");
    const hash = new Uint8Array([0, 7, 255]);
    const userId = newId();
    await db.orm.insert(store.users).values({ id: userId, email: `${userId}@t.dev` });
    await db.orm.insert(store.apiTokens).values({
      id: newId(),
      tenantId,
      userId,
      tokenHash: hash,
      scopes: ["*", "a,b"],
    });
    const tok = await db.orm
      .select()
      .from(store.apiTokens)
      .where(eq(store.apiTokens.tokenHash, hash));
    expect(Array.from(tok[0].tokenHash)).toEqual([0, 7, 255]);
    expect(tok[0].scopes).toEqual(["*", "a,b"]);
  });
});

// ---------- helpers ----------
function isPgTable(v: object): boolean {
  try {
    getTableConfig(v as PgTable);
    return true;
  } catch {
    // not a table (functions, constants, classes)
    return false;
  }
}
