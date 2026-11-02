// Personal / device API tokens. Stored hashed only; the token itself is shown once.
import { newId } from "@exa/protocol";
import type { Db } from "@exa/store";
import { hashToken, randomToken } from "../helpers/tokens.helper.ts";
import type { NewApiToken, VerifiedApiToken } from "../models/identity.model.ts";

// ---------- constants ----------
const API_TOKEN_PREFIX = "exa";

// ---------- api token repo ----------
export class ApiTokenRepo {
  constructor(private readonly db: Db) {}

  async create(opts: NewApiToken): Promise<{ id: string; token: string }> {
    const token = randomToken(API_TOKEN_PREFIX);
    const id = newId();
    await this.db.query(
      `insert into api_tokens (id, tenant_id, user_id, name, device_name, token_hash, scopes, expires_at)
       values ($1,$2,$3,$4,$5,$6,coalesce((select array_agg(x) from jsonb_array_elements_text((($7)::text)::jsonb) x), '{}'), case when $8::int is null then null else now() + make_interval(days => $8::int) end)`,
      [
        id,
        opts.tenantId,
        opts.userId,
        opts.name ?? null,
        opts.deviceName ?? null,
        hashToken(token),
        JSON.stringify(opts.scopes ?? ["*"]),
        opts.ttlDays ?? null,
      ],
    );
    return { id, token };
  }

  async verify(token: string): Promise<VerifiedApiToken | null> {
    const r = await this.db.query<any>(
      `update api_tokens set last_used_at = now()
       where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())
       returning id, tenant_id, user_id, scopes`,
      [hashToken(token)],
    );
    return r[0]
      ? { id: r[0].id, tenantId: r[0].tenant_id, userId: r[0].user_id, scopes: r[0].scopes }
      : null;
  }

  async revoke(tenantId: string, userId: string, id: string): Promise<boolean> {
    const r = await this.db.query(
      `update api_tokens set revoked_at = now() where id = $1 and tenant_id = $2 and user_id = $3 and revoked_at is null returning id`,
      [id, tenantId, userId],
    );
    return r.length > 0;
  }

  async list(tenantId: string, userId: string) {
    return this.db.query<any>(
      `select id, name, device_name, scopes, last_used_at, expires_at, revoked_at, created_at from api_tokens where tenant_id = $1 and user_id = $2 order by created_at desc`,
      [tenantId, userId],
    );
  }
}
