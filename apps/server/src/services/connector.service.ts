// Connectors: remote MCP servers (streamable HTTP) the server-side agent can use. Users manage
// their own; admins manage the org's. Secret headers are sealed with the KeyVault and never
// returned or logged, and every URL is checked against private networks on save and on connect.

import { type api, type Connector, isUuid } from "@exa/protocol";
import { assertPublicHost } from "@exa/tools";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import {
  combineMcpConnections,
  connectMcpServer,
  type McpConnection,
} from "../helpers/mcp-connect.helper.ts";
import { isAdmin } from "../helpers/role.helper.ts";
import type {
  ConnectedTools,
  ConnectorScope,
  ConnectorTestResult,
  ConnectorWithSecret,
  SealedHeaders,
  StoredConnector,
} from "../models/connector.model.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { Subject } from "../models/subject.model.ts";
import type { ServiceDeps } from "./service-deps.ts";

// ---------- constants ----------
/** How long one connector gets to finish the MCP handshake and list its tools. */
const CONNECT_TIMEOUT_MS = 10_000;
const REDACTED = "[redacted]";
/** Shorter secret fragments are not scrubbed from error text (they'd match everywhere). */
const MIN_REDACT_CHARS = 4;
/** Connector errors are shown in the UI; an upstream error page is cut to this many chars. */
const MAX_ERROR_CHARS = 200;
const HTTPS = "https:";
const HTTP = "http:";

// ---------- types ----------
type PutConnectorInput = z.infer<typeof api.PutConnectorBody>;
type PatchConnectorInput = z.infer<typeof api.PatchConnectorBody>;

export type ConnectorServiceDeps = Pick<
  ServiceDeps,
  "cfg" | "connectors" | "vault" | "telemetry"
> & {
  /** Outbound fetch for MCP traffic (tests stub it). */
  fetch?: typeof fetch;
};

// ---------- connector service ----------
export class ConnectorService {
  constructor(private readonly deps: ConnectorServiceDeps) {}

  async list(p: Principal): Promise<Connector[]> {
    return (await this.deps.connectors.list(p)).map(toConnector);
  }

  async create(p: Principal, input: PutConnectorInput): Promise<Connector> {
    assertCanManage(p, input.scope);
    await this.assertUrlAllowed(input.url);
    const created = await this.deps.connectors.create(p, {
      scope: input.scope,
      name: input.name,
      url: input.url,
      enabled: input.enabled,
      headerNames: Object.keys(input.headers),
      sealed: await this.seal(p.tenantId, input.headers),
    });
    if (!created)
      throw new HttpError(
        409,
        `a connector named "${input.name}" already exists`,
        ERROR_CODES.conflict,
      );
    this.audit(p, "connector.created", created);
    return toConnector(created);
  }

  async update(p: Principal, id: string, input: PatchConnectorInput): Promise<Connector> {
    const current = await this.manageable(p, id);
    if (input.url) await this.assertUrlAllowed(input.url);
    const headers = input.headers && {
      names: Object.keys(input.headers),
      sealed: await this.seal(p.tenantId, input.headers),
    };
    const updated = await this.deps.connectors.update(p.tenantId, current, {
      url: input.url,
      enabled: input.enabled,
      headers,
    });
    if (!updated) throw notFound();
    this.audit(p, "connector.updated", updated);
    return toConnector(updated);
  }

  async remove(p: Principal, id: string): Promise<void> {
    const current = await this.manageable(p, id);
    if (!(await this.deps.connectors.remove(p.tenantId, current))) throw notFound();
    this.audit(p, "connector.deleted", current);
  }

  /** Connects once (enabled or not) and lists the server's tools; failures are `ok: false`. */
  async test(p: Principal, id: string): Promise<ConnectorTestResult> {
    const connector = isUuid(id) ? await this.deps.connectors.getWithSecret(p, id) : null;
    if (!connector) throw notFound();
    const connection = await this.connect(p.tenantId, connector);
    if (!connection.manager) return { ok: false, tools: [], error: connection.error };
    const tools = connection.manager.clients.flatMap((c) => c.tools);
    await connection.manager.close();
    return {
      ok: true,
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
    };
  }

  /** The subject's enabled connectors, connected for one live session; broken ones are skipped. */
  async connectFor(s: Subject): Promise<ConnectedTools> {
    const connectors = preferOwn(await this.deps.connectors.enabledFor(s));
    const connections = await Promise.all(connectors.map((c) => this.connect(s.tenantId, c)));
    for (const c of connections) {
      if (c.error) console.error(`[exa-server] connector "${c.name}" unavailable: ${c.error}`);
    }
    return combineMcpConnections(connections);
  }

  /** Never throws; any failure is `error`, with secret header values scrubbed from it. */
  private async connect(tenantId: string, c: ConnectorWithSecret): Promise<McpConnection> {
    let headers: Record<string, string> = {};
    try {
      await this.assertUrlAllowed(c.url);
      headers = await this.openHeaders(tenantId, c);
      const target = { name: c.name, url: c.url, headers };
      const opts = { timeoutMs: CONNECT_TIMEOUT_MS, fetch: this.deps.fetch };
      const connection = await connectMcpServer(target, opts);
      if (!connection.error) return connection;
      return { ...connection, error: readableError(redact(connection.error, headers)) };
    } catch (err) {
      const error = readableError(redact((err as Error).message ?? String(err), headers));
      return { name: c.name, manager: null, tools: [], error };
    }
  }

  private async openHeaders(
    tenantId: string,
    c: ConnectorWithSecret,
  ): Promise<Record<string, string>> {
    if (!c.sealed) return {};
    if (!this.deps.vault)
      throw new Error("its secret headers can't be decrypted: the server has no EXA_MASTER_KEY");
    return JSON.parse(await this.deps.vault.decrypt(tenantId, c.sealed)) as Record<string, string>;
  }

  /** Header values are encrypted at rest, so headers need the BYOK vault (EXA_MASTER_KEY). */
  private async seal(
    tenantId: string,
    headers: Record<string, string>,
  ): Promise<SealedHeaders | null> {
    if (!Object.keys(headers).length) return null;
    if (!this.deps.vault)
      throw new HttpError(
        400,
        "secret headers are stored encrypted, but this server has no EXA_MASTER_KEY " +
          "configured (BYOK is disabled); set one, or save the connector without headers",
        ERROR_CODES.byokDisabled,
      );
    const { ciphertext, wrappedDek, keyVersion } = await this.deps.vault.encrypt(
      tenantId,
      JSON.stringify(headers),
    );
    return { ciphertext, wrappedDek, keyVersion };
  }

  private async assertUrlAllowed(url: string): Promise<void> {
    const problem = await urlProblem(url, this.deps.cfg.connectorsAllowPrivate);
    if (problem) throw new HttpError(400, problem, ERROR_CODES.validation);
  }

  /** A connector the caller can see and change: their own, or the org's when an admin. */
  private async manageable(p: Principal, id: string): Promise<StoredConnector> {
    const connector = isUuid(id) ? await this.deps.connectors.get(p, id) : null;
    if (!connector) throw notFound();
    assertCanManage(p, connector.scope);
    return connector;
  }

  private audit(p: Principal, action: string, c: StoredConnector): void {
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action,
      target: `${c.scope}:${c.name}`,
    });
  }
}

// ---------- helpers ----------
function toConnector(c: StoredConnector): Connector {
  return {
    id: c.id,
    name: c.name,
    scope: c.scope,
    url: c.url,
    enabled: c.enabled,
    secretHeaders: c.headerNames,
    time: { created: c.createdAt.getTime(), updated: c.updatedAt.getTime() },
  };
}

function assertCanManage(p: Principal, scope: ConnectorScope): void {
  if (scope === "tenant" && !isAdmin(p))
    throw new HttpError(403, "only admins can manage org connectors", ERROR_CODES.forbidden);
}

function notFound(): HttpError {
  return new HttpError(404, "connector not found", ERROR_CODES.notFound);
}

/**
 * Why a URL may not be used, or null. https only (plain http, and private, loopback,
 * link-local or CGNAT hosts, only with EXA_CONNECTORS_ALLOW_PRIVATE=1).
 */
async function urlProblem(raw: string, allowPrivate: boolean): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // unparseable input is reported, not thrown
    return "connector URL is not a valid URL";
  }
  const isAllowedScheme = url.protocol === HTTPS || (allowPrivate && url.protocol === HTTP);
  if (!isAllowedScheme) return "connector URLs must use https://";
  if (url.username || url.password)
    return "put credentials in secret headers, not in the connector URL";
  if (allowPrivate) return null;
  try {
    await assertPublicHost(url.hostname);
    return null;
  } catch (err) {
    return `connector URL not allowed: ${(err as Error).message}`;
  }
}

/** On a name clash between the user's and the org's connector, the user's wins. */
function preferOwn(connectors: ConnectorWithSecret[]): ConnectorWithSecret[] {
  const byName = new Map<string, ConnectorWithSecret>();
  for (const c of connectors) {
    const seen = byName.get(c.name);
    if (!seen || c.scope === "user") byName.set(c.name, c);
  }
  return [...byName.values()];
}

/** Error text for people: an upstream HTML error page becomes its plain words, capped. */
function readableError(message: string): string {
  const plain = message
    .replace(/<(style|script)[\s\S]*?(<\/\1>|$)/gi, " ")
    .replace(/<[^>]*>?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= MAX_ERROR_CHARS) return plain;
  return `${plain.slice(0, MAX_ERROR_CHARS)}…`;
}

/** Scrubs header values (and a bearer token's bare token) out of an error message. */
function redact(message: string, headers: Record<string, string>): string {
  const secrets = Object.values(headers).flatMap((v) => [v, v.split(/\s+/).at(-1) ?? ""]);
  return secrets
    .filter((s) => s.length >= MIN_REDACT_CHARS)
    .sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join(REDACTED), message);
}
