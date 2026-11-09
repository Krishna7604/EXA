// BYOK provider keys, stored as ciphertext only (sealed by the router's KeyVault).
// A user key takes precedence over the tenant key for the same provider.
import { newId } from "@exa/protocol";
import { type Db, providerKeys } from "@exa/store";
import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import type {
  KeyOwnerScope,
  NewProviderKey,
  ProviderKeySummary,
  StoredProviderKey,
} from "../models/provider-key.model.ts";
import type { Subject } from "../models/subject.model.ts";

// ---------- constants ----------
const USER_KEY_FIRST = sql`case ${providerKeys.ownerScope} when 'user' then 0 else 1 end`;

// ---------- provider keys repo ----------
export class ProviderKeysRepo {
  constructor(private readonly db: Db) {}

  /** Stores a new key and revokes the owner's previous key for that provider. */
  async put(s: Subject, k: NewProviderKey): Promise<string> {
    const id = newId();
    const ownerId = k.ownerScope === "tenant" ? s.tenantId : s.userId;
    await this.db.withTenant(s.tenantId, async (q) => {
      await q.orm
        .update(providerKeys)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(providerKeys.ownerScope, k.ownerScope),
            eq(providerKeys.ownerId, ownerId),
            eq(providerKeys.provider, k.provider),
            isNull(providerKeys.revokedAt),
          ),
        );
      await q.orm.insert(providerKeys).values({
        id,
        tenantId: s.tenantId,
        ownerScope: k.ownerScope,
        ownerId,
        provider: k.provider,
        label: k.label ?? null,
        ciphertext: k.ciphertext,
        wrappedDek: k.wrappedDek,
        keyVersion: k.keyVersion,
        last4: k.last4,
      });
    });
    return id;
  }

  /** User key first, then tenant key. */
  async find(s: Subject, provider: string): Promise<StoredProviderKey | null> {
    const [row] = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .select({
          id: providerKeys.id,
          ownerScope: providerKeys.ownerScope,
          ciphertext: providerKeys.ciphertext,
          wrappedDek: providerKeys.wrappedDek,
          keyVersion: providerKeys.keyVersion,
        })
        .from(providerKeys)
        .where(
          and(
            eq(providerKeys.provider, provider),
            isNull(providerKeys.revokedAt),
            or(ownedByUser(s.userId), ownedByTenant(s.tenantId)),
          ),
        )
        .orderBy(USER_KEY_FIRST)
        .limit(1),
    );
    if (!row) return null;
    return { ...row, ownerScope: row.ownerScope as KeyOwnerScope };
  }

  async list(s: Subject): Promise<ProviderKeySummary[]> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .select({
          id: providerKeys.id,
          provider: providerKeys.provider,
          ownerScope: providerKeys.ownerScope,
          label: providerKeys.label,
          last4: providerKeys.last4,
          createdAt: providerKeys.createdAt,
          lastUsedAt: providerKeys.lastUsedAt,
        })
        .from(providerKeys)
        .where(
          and(
            isNull(providerKeys.revokedAt),
            or(ownedByUser(s.userId), eq(providerKeys.ownerScope, "tenant")),
          ),
        )
        .orderBy(providerKeys.provider),
    );
    return rows.map((x) => ({
      id: x.id,
      provider: x.provider,
      ownerScope: x.ownerScope,
      label: x.label,
      last4: x.last4,
      createdAt: String(x.createdAt),
      lastUsedAt: x.lastUsedAt ? String(x.lastUsedAt) : null,
    }));
  }

  async revoke(s: Subject, id: string, allowTenant: boolean): Promise<boolean> {
    const tenantKey = allowTenant ? eq(providerKeys.ownerScope, "tenant") : undefined;
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .update(providerKeys)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(providerKeys.id, id),
            isNull(providerKeys.revokedAt),
            or(ownedByUser(s.userId), tenantKey),
          ),
        )
        .returning({ id: providerKeys.id }),
    );
    return rows.length > 0;
  }

  async touch(tenantId: string, id: string): Promise<void> {
    await this.db.withTenant(tenantId, (q) =>
      q.orm.update(providerKeys).set({ lastUsedAt: sql`now()` }).where(eq(providerKeys.id, id)),
    );
  }
}

// ---------- helpers ----------
function ownedByUser(userId: string): SQL | undefined {
  return and(eq(providerKeys.ownerScope, "user"), eq(providerKeys.ownerId, userId));
}

function ownedByTenant(tenantId: string): SQL | undefined {
  return and(eq(providerKeys.ownerScope, "tenant"), eq(providerKeys.ownerId, tenantId));
}
