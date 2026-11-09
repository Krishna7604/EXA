// Tenant memberships (who belongs to which organization, with which role). Global table.
import { type Db, memberships, tenants, users } from "@exa/store";
import { and, eq, sql } from "drizzle-orm";
import type { Membership, Role, Tenant } from "../models/identity.model.ts";
import { tenantFromRow } from "./tenant.repository.ts";

// ---------- membership repo ----------
export class MembershipRepo {
  constructor(private readonly db: Db) {}

  async add(tenantId: string, userId: string, role: Role): Promise<void> {
    await this.db.orm
      .insert(memberships)
      .values({ tenantId, userId, role })
      .onConflictDoUpdate({
        target: [memberships.tenantId, memberships.userId],
        set: { role: sql`excluded.role`, status: "active" },
      });
  }

  async active(tenantId: string, userId: string): Promise<Membership | null> {
    const [row] = await this.db.orm
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, userId),
          eq(memberships.status, "active"),
        ),
      );
    return row ? membershipFromRow(row) : null;
  }

  async ofTenant(tenantId: string): Promise<Array<Membership & { email: string }>> {
    const rows = await this.db.orm
      .select({ membership: memberships, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, tenantId))
      .orderBy(users.email);
    return rows.map((x) => ({ ...membershipFromRow(x.membership), email: x.email }));
  }

  async tenantsOfUser(userId: string): Promise<Array<Tenant & { role: Role }>> {
    const rows = await this.db.orm
      .select({ tenant: tenants, role: memberships.role })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")))
      .orderBy(tenants.slug);
    return rows.map((x) => ({ ...tenantFromRow(x.tenant), role: x.role as Role }));
  }
}

// ---------- helpers ----------
function membershipFromRow(r: typeof memberships.$inferSelect): Membership {
  return { tenantId: r.tenantId, userId: r.userId, role: r.role as Role, status: r.status };
}
