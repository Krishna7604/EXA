// BYOK provider keys, stored as ciphertext only (sealed by the router's KeyVault).
// A user key takes precedence over the tenant key for the same provider.
import { newId } from "@exa/protocol";
import type { Db } from "@exa/store";
import type {
  NewProviderKey,
  ProviderKeySummary,
  StoredProviderKey,
} from "../models/provider-key.model.ts";
import type { Subject } from "../models/subject.model.ts";

// ---------- provider keys repo ----------
export class ProviderKeysRepo {
  constructor(private readonly db: Db) {}

  /** Stores a new key and revokes the owner's previous key for that provider. */
  async put(s: Subject, k: NewProviderKey): Promise<string> {
    const id = newId();
    const ownerId = k.ownerScope === "tenant" ? s.tenantId : s.userId;
    await this.db.withTenant(s.tenantId, async (q) => {
      await q.query(
        `update provider_keys set revoked_at = now() where owner_scope = $1 and owner_id = $2 and provider = $3 and revoked_at is null`,
        [k.ownerScope, ownerId, k.provider],
      );
      await q.query(
        `insert into provider_keys (id, tenant_id, owner_scope, owner_id, provider, label, ciphertext, wrapped_dek, key_version, last4)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          s.tenantId,
          k.ownerScope,
          ownerId,
          k.provider,
          k.label ?? null,
          Buffer.from(k.ciphertext),
          Buffer.from(k.wrappedDek),
          k.keyVersion,
          k.last4,
        ],
      );
    });
    return id;
  }

  /** User key first, then tenant key. */
  async find(s: Subject, provider: string): Promise<StoredProviderKey | null> {
    const r = await this.db.withTenant(s.tenantId, (q) =>
      q.query<any>(
        `select id, owner_scope, ciphertext, wrapped_dek, key_version from provider_keys
         where provider = $1 and revoked_at is null and ((owner_scope = 'user' and owner_id = $2) or (owner_scope = 'tenant' and owner_id = $3))
         order by case owner_scope when 'user' then 0 else 1 end limit 1`,
        [provider, s.userId, s.tenantId],
      ),
    );
    const row = r[0];
    if (!row) return null;
    return {
      id: row.id,
      ownerScope: row.owner_scope,
      ciphertext: new Uint8Array(row.ciphertext),
      wrappedDek: new Uint8Array(row.wrapped_dek),
      keyVersion: row.key_version,
    };
  }

  async list(s: Subject): Promise<ProviderKeySummary[]> {
    const r = await this.db.withTenant(s.tenantId, (q) =>
      q.query<any>(
        `select id, provider, owner_scope, label, last4, created_at, last_used_at from provider_keys
         where revoked_at is null and ((owner_scope = 'user' and owner_id = $1) or owner_scope = 'tenant') order by provider`,
        [s.userId],
      ),
    );
    return r.map((x) => ({
      id: x.id,
      provider: x.provider,
      ownerScope: x.owner_scope,
      label: x.label,
      last4: x.last4,
      createdAt: String(x.created_at),
      lastUsedAt: x.last_used_at ? String(x.last_used_at) : null,
    }));
  }

  async revoke(s: Subject, id: string, allowTenant: boolean): Promise<boolean> {
    const r = await this.db.withTenant(s.tenantId, (q) =>
      q.query(
        `update provider_keys set revoked_at = now() where id = $1 and revoked_at is null
         and ((owner_scope = 'user' and owner_id = $2) or ($3 and owner_scope = 'tenant')) returning id`,
        [id, s.userId, allowTenant],
      ),
    );
    return r.length > 0;
  }

  async touch(tenantId: string, id: string): Promise<void> {
    await this.db.withTenant(tenantId, (q) =>
      q.query(`update provider_keys set last_used_at = now() where id = $1`, [id]),
    );
  }
}
