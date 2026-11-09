// Personal / device API tokens. Stored hashed only; the token itself is shown once.
import { newId } from "@exa/protocol";
import { apiTokens, type Db } from "@exa/store";
import { and, desc, eq, gt, isNull, or, type SQL, sql } from "drizzle-orm";
import { hashToken, randomToken } from "../helpers/tokens.helper.ts";
import type { NewApiToken, VerifiedApiToken } from "../models/identity.model.ts";

// ---------- constants ----------
const API_TOKEN_PREFIX = "exa";
const DEFAULT_SCOPES = ["*"];

// ---------- api token repo ----------
export class ApiTokenRepo {
  constructor(private readonly db: Db) {}

  async create(opts: NewApiToken): Promise<{ id: string; token: string }> {
    const token = randomToken(API_TOKEN_PREFIX);
    const id = newId();
    await this.db.orm.insert(apiTokens).values({
      id,
      tenantId: opts.tenantId,
      userId: opts.userId,
      name: opts.name ?? null,
      deviceName: opts.deviceName ?? null,
      tokenHash: hashToken(token),
      scopes: opts.scopes ?? DEFAULT_SCOPES,
      expiresAt: expiryAfterDays(opts.ttlDays ?? null),
    });
    return { id, token };
  }

  async verify(token: string): Promise<VerifiedApiToken | null> {
    const [row] = await this.db.orm
      .update(apiTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(apiTokens.tokenHash, hashToken(token)),
          isNull(apiTokens.revokedAt),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, sql`now()`)),
        ),
      )
      .returning({
        id: apiTokens.id,
        tenantId: apiTokens.tenantId,
        userId: apiTokens.userId,
        scopes: apiTokens.scopes,
      });
    return row ?? null;
  }

  async revoke(tenantId: string, userId: string, id: string): Promise<boolean> {
    const rows = await this.db.orm
      .update(apiTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(apiTokens.id, id),
          eq(apiTokens.tenantId, tenantId),
          eq(apiTokens.userId, userId),
          isNull(apiTokens.revokedAt),
        ),
      )
      .returning({ id: apiTokens.id });
    return rows.length > 0;
  }

  /** The user's tokens, newest first, as snake_case rows (the API returns them as-is). */
  async list(tenantId: string, userId: string) {
    return this.db.orm
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        device_name: apiTokens.deviceName,
        scopes: apiTokens.scopes,
        last_used_at: apiTokens.lastUsedAt,
        expires_at: apiTokens.expiresAt,
        revoked_at: apiTokens.revokedAt,
        created_at: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.tenantId, tenantId), eq(apiTokens.userId, userId)))
      .orderBy(desc(apiTokens.createdAt));
  }
}

// ---------- helpers ----------
/** `now() + ttlDays`, or null (never expires). */
function expiryAfterDays(ttlDays: number | null): SQL | null {
  if (ttlDays === null) return null;
  return sql`now() + make_interval(days => ${ttlDays}::int)`;
}
