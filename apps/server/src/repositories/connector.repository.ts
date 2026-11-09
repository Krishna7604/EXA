// Connectors: remote MCP servers the server-side agent uses, stored as `mcp_servers` rows with
// runs_on='server' and transport='http'. `config` holds only `{ url, headerNames }`; the header
// values are one sealed JSON object in `secrets`, deleted together with the connector.
import { newId } from "@exa/protocol";
import { type Db, type DbTx, mcpServers, secrets } from "@exa/store";
import { and, asc, desc, eq, or, type SQL, sql } from "drizzle-orm";
import type {
  ConnectorChanges,
  ConnectorScope,
  ConnectorWithSecret,
  NewConnector,
  SealedHeaders,
  StoredConnector,
} from "../models/connector.model.ts";
import type { Subject } from "../models/subject.model.ts";

// ---------- constants ----------
const RUNS_ON_SERVER = "server";
const HTTP_TRANSPORT = "http";
const SECRET_NAME_PREFIX = "connector:";

// ---------- types ----------
/** The non-secret part of a connector, as kept in `mcp_servers.config`. */
type ConnectorConfig = {
  url?: string;
  headerNames?: string[];
};

type ConnectorRow = typeof mcpServers.$inferSelect;
type SecretRow = typeof secrets.$inferSelect;

// ---------- connector repo ----------
export class ConnectorRepo {
  constructor(private readonly db: Db) {}

  /** The user's own connectors first, then the org's; by name within each. */
  async list(s: Subject): Promise<StoredConnector[]> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .select()
        .from(mcpServers)
        .where(visibleTo(s))
        .orderBy(desc(mcpServers.scope), asc(mcpServers.name)),
    );
    return rows.map(connectorFromRow);
  }

  /** One connector the subject can see (their own, or the org's), or null. */
  async get(s: Subject, id: string): Promise<StoredConnector | null> {
    const [row] = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .select()
        .from(mcpServers)
        .where(and(visibleTo(s), eq(mcpServers.id, id))),
    );
    return row ? connectorFromRow(row) : null;
  }

  /** One visible connector with its sealed headers (enabled or not), or null. */
  async getWithSecret(s: Subject, id: string): Promise<ConnectorWithSecret | null> {
    const [found] = await this.selectWithSecrets(s, eq(mcpServers.id, id));
    return found ?? null;
  }

  /** Every enabled connector the subject can see, with sealed headers, for connecting. */
  enabledFor(s: Subject): Promise<ConnectorWithSecret[]> {
    return this.selectWithSecrets(s, eq(mcpServers.enabled, true));
  }

  /** Null when the owner already has a connector with that name. */
  async create(s: Subject, c: NewConnector): Promise<StoredConnector | null> {
    const id = newId();
    const secretId = c.sealed ? newId() : null;
    return this.db.withTenant(s.tenantId, async (q) => {
      const [row] = await q.orm
        .insert(mcpServers)
        .values({
          id,
          tenantId: s.tenantId,
          scope: c.scope,
          scopeId: scopeIdFor(s, c.scope),
          name: c.name,
          transport: HTTP_TRANSPORT,
          config: configFor(c.url, c.headerNames),
          secretId,
          runsOn: RUNS_ON_SERVER,
          enabled: c.enabled,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      if (c.sealed && secretId)
        await insertSecret(q, { tenantId: s.tenantId, id, secretId }, c.sealed);
      return connectorFromRow(row);
    });
  }

  async update(
    tenantId: string,
    current: StoredConnector,
    changes: ConnectorChanges,
  ): Promise<StoredConnector | null> {
    return this.db.withTenant(tenantId, async (q) => {
      const secretId = await replaceSecret(q, { tenantId, current }, changes.headers);
      const url = changes.url ?? current.url;
      const headerNames = changes.headers?.names ?? current.headerNames;
      const [row] = await q.orm
        .update(mcpServers)
        .set({
          config: configFor(url, headerNames),
          enabled: changes.enabled ?? current.enabled,
          secretId,
          updatedAt: sql`now()`,
        })
        .where(eq(mcpServers.id, current.id))
        .returning();
      return row ? connectorFromRow(row) : null;
    });
  }

  /** Deletes the connector and its sealed headers. */
  async remove(tenantId: string, current: StoredConnector): Promise<boolean> {
    return this.db.withTenant(tenantId, async (q) => {
      const deleted = await q.orm
        .delete(mcpServers)
        .where(eq(mcpServers.id, current.id))
        .returning({ id: mcpServers.id });
      if (current.secretId) await q.orm.delete(secrets).where(eq(secrets.id, current.secretId));
      return deleted.length > 0;
    });
  }

  private async selectWithSecrets(s: Subject, filter: SQL): Promise<ConnectorWithSecret[]> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .select({ connector: mcpServers, secret: secrets })
        .from(mcpServers)
        .leftJoin(secrets, eq(secrets.id, mcpServers.secretId))
        .where(and(visibleTo(s), filter))
        .orderBy(desc(mcpServers.scope), asc(mcpServers.name)),
    );
    return rows.map((r) => ({ ...connectorFromRow(r.connector), sealed: sealedFromRow(r.secret) }));
  }
}

// ---------- helpers ----------
/** Server-side connectors that are the user's own or the tenant's. */
function visibleTo(s: Subject): SQL {
  const own = and(eq(mcpServers.scope, "user"), eq(mcpServers.scopeId, s.userId));
  const org = and(eq(mcpServers.scope, "tenant"), eq(mcpServers.scopeId, s.tenantId));
  return and(eq(mcpServers.runsOn, RUNS_ON_SERVER), or(own, org)) as SQL;
}

function scopeIdFor(s: Subject, scope: ConnectorScope): string {
  return scope === "tenant" ? s.tenantId : s.userId;
}

function configFor(url: string, headerNames: string[]): ConnectorConfig {
  return { url, headerNames };
}

async function insertSecret(
  q: DbTx,
  ids: { tenantId: string; id: string; secretId: string },
  sealed: SealedHeaders,
): Promise<void> {
  await q.orm.insert(secrets).values({
    id: ids.secretId,
    tenantId: ids.tenantId,
    name: `${SECRET_NAME_PREFIX}${ids.id}`,
    ...sealed,
  });
}

/** Applies a header change; returns the connector's secret id afterwards. */
async function replaceSecret(
  q: DbTx,
  target: { tenantId: string; current: StoredConnector },
  headers: ConnectorChanges["headers"],
): Promise<string | null> {
  const { tenantId, current } = target;
  if (!headers) return current.secretId;
  if (current.secretId) await q.orm.delete(secrets).where(eq(secrets.id, current.secretId));
  if (!headers.sealed) return null;
  const secretId = newId();
  await insertSecret(q, { tenantId, id: current.id, secretId }, headers.sealed);
  return secretId;
}

function connectorFromRow(r: ConnectorRow): StoredConnector {
  const cfg = (r.config ?? {}) as ConnectorConfig;
  return {
    id: r.id,
    scope: r.scope as ConnectorScope,
    scopeId: r.scopeId,
    name: r.name,
    url: String(cfg.url ?? ""),
    enabled: r.enabled,
    headerNames: Array.isArray(cfg.headerNames) ? cfg.headerNames.map(String) : [],
    secretId: r.secretId ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function sealedFromRow(r: SecretRow | null): SealedHeaders | null {
  if (!r) return null;
  return { ciphertext: r.ciphertext, wrappedDek: r.wrappedDek, keyVersion: r.keyVersion };
}
