// Tenants (organizations). A global table (no RLS), so queries run as the owner.
import { newId } from "@exa/protocol";
import type { Db } from "@exa/store";
import type { Tenant } from "../models/identity.model.ts";

// ---------- tenant repo ----------
export class TenantRepo {
  constructor(private readonly db: Db) {}

  async create(slug: string, name = slug): Promise<Tenant> {
    const rows = await this.db.query(
      `insert into tenants (id, slug, name) values ($1,$2,$3) returning *`,
      [newId(), slug, name],
    );
    return tenantFromRow(rows[0]);
  }

  async bySlug(slug: string): Promise<Tenant | null> {
    const r = await this.db.query(`select * from tenants where slug = $1`, [slug]);
    return r[0] ? tenantFromRow(r[0]) : null;
  }

  async byId(id: string): Promise<Tenant | null> {
    const r = await this.db.query(`select * from tenants where id = $1`, [id]);
    return r[0] ? tenantFromRow(r[0]) : null;
  }

  async allActive(): Promise<Tenant[]> {
    const rows = await this.db.query(`select * from tenants where status = 'active' order by slug`);
    return rows.map(tenantFromRow);
  }

  async bumpPolicyVersion(tenantId: string): Promise<number> {
    const r = await this.db.query<{ policy_version: string }>(
      `update tenants set policy_version = policy_version + 1 where id = $1 returning policy_version`,
      [tenantId],
    );
    return Number(r[0]?.policy_version ?? 0);
  }
}

// ---------- row mapping ----------
// biome-ignore lint/suspicious/noExplicitAny: raw driver row
export function tenantFromRow(r: any): Tenant {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    plan: r.plan,
    status: r.status,
    policyVersion: Number(r.policy_version),
  };
}
