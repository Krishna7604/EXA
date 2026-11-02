// Tenant memberships (who belongs to which organization, with which role). Global table.
import type { Db } from "@exa/store";
import type { Membership, Role, Tenant } from "../models/identity.model.ts";
import { tenantFromRow } from "./tenant.repository.ts";

// ---------- membership repo ----------
export class MembershipRepo {
  constructor(private readonly db: Db) {}

  async add(tenantId: string, userId: string, role: Role): Promise<void> {
    await this.db.query(
      `insert into memberships (tenant_id, user_id, role) values ($1,$2,$3)
       on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'active'`,
      [tenantId, userId, role],
    );
  }

  async active(tenantId: string, userId: string): Promise<Membership | null> {
    const r = await this.db.query<any>(
      `select * from memberships where tenant_id = $1 and user_id = $2 and status = 'active'`,
      [tenantId, userId],
    );
    return r[0]
      ? { tenantId: r[0].tenant_id, userId: r[0].user_id, role: r[0].role, status: r[0].status }
      : null;
  }

  async ofTenant(tenantId: string): Promise<Array<Membership & { email: string }>> {
    const r = await this.db.query<any>(
      `select m.*, u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 order by u.email`,
      [tenantId],
    );
    return r.map((x) => ({
      tenantId: x.tenant_id,
      userId: x.user_id,
      role: x.role,
      status: x.status,
      email: x.email,
    }));
  }

  async tenantsOfUser(userId: string): Promise<Array<Tenant & { role: Role }>> {
    const r = await this.db.query<any>(
      `select t.*, m.role from memberships m join tenants t on t.id = m.tenant_id where m.user_id = $1 and m.status = 'active' order by t.slug`,
      [userId],
    );
    return r.map((x) => ({ ...tenantFromRow(x), role: x.role }));
  }
}
