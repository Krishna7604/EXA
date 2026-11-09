// Tenants (organizations). A global table (no RLS), so queries run as the owner.
import { newId } from "@exa/protocol";
import { type Db, tenants } from "@exa/store";
import { eq, sql } from "drizzle-orm";
import type { Tenant } from "../models/identity.model.ts";

// ---------- tenant repo ----------
export class TenantRepo {
  constructor(private readonly db: Db) {}

  async create(slug: string, name = slug): Promise<Tenant> {
    const [row] = await this.db.orm.insert(tenants).values({ id: newId(), slug, name }).returning();
    return tenantFromRow(row);
  }

  async bySlug(slug: string): Promise<Tenant | null> {
    const [row] = await this.db.orm.select().from(tenants).where(eq(tenants.slug, slug));
    return row ? tenantFromRow(row) : null;
  }

  async byId(id: string): Promise<Tenant | null> {
    const [row] = await this.db.orm.select().from(tenants).where(eq(tenants.id, id));
    return row ? tenantFromRow(row) : null;
  }

  async allActive(): Promise<Tenant[]> {
    const rows = await this.db.orm
      .select()
      .from(tenants)
      .where(eq(tenants.status, "active"))
      .orderBy(tenants.slug);
    return rows.map(tenantFromRow);
  }

  async bumpPolicyVersion(tenantId: string): Promise<number> {
    const [row] = await this.db.orm
      .update(tenants)
      .set({ policyVersion: sql`${tenants.policyVersion} + 1` })
      .where(eq(tenants.id, tenantId))
      .returning({ policyVersion: tenants.policyVersion });
    return row?.policyVersion ?? 0;
  }
}

// ---------- row mapping ----------
export function tenantFromRow(r: typeof tenants.$inferSelect): Tenant {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    plan: r.plan,
    status: r.status,
    policyVersion: r.policyVersion,
  };
}
