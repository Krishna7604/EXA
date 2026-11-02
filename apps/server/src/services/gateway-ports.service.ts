// The model gateway's view of the server: BYOK credentials, the org's model policy, quota
// checks and usage telemetry. Lookups are cached briefly because they run on every model call.

import { ModelError } from "@exa/protocol";
import type {
  Credential,
  GatewayPorts,
  Principal as GatewayPrincipal,
  KeyVault,
  ModelPolicy,
  UsageRecord,
} from "@exa/router";
import { TtlCache } from "../helpers/ttl-cache.helper.ts";
import type { ConfigRepo } from "../repositories/config.repository.ts";
import type { TelemetryWriter } from "../repositories/telemetry.repository.ts";
import type { SettingsCache } from "./settings-cache.service.ts";

// ---------- constants ----------
const CREDENTIAL_TTL_MS = 60_000;
const QUOTA_TTL_MS = 5_000;
const QUOTA_EXCEEDED_STATUS = 429;
const DEFAULT_BEDROCK_REGION = "us-east-1";
/** "ACCESS_KEY_ID:SECRET" means SigV4 credentials; anything else is a Bedrock API key (bearer). */
const AWS_KEY_PAIR = /^(AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}):(.+)$/;

// ---------- types ----------
export interface GatewayPortsDeps {
  config: ConfigRepo;
  telemetry: TelemetryWriter;
  vault: KeyVault | null;
  settings: SettingsCache;
}

type KeySource = Credential["source"];

// ---------- cached gateway ports ----------
export class CachedGatewayPorts implements GatewayPorts {
  private readonly credentials = new TtlCache<Credential | null>(CREDENTIAL_TTL_MS);
  /** Quota-exceeded message per user, or null when under quota. */
  private readonly quotas = new TtlCache<string | null>(QUOTA_TTL_MS);

  constructor(private readonly deps: GatewayPortsDeps) {}

  async byok(p: GatewayPrincipal, provider: string): Promise<Credential | null> {
    const vault = this.deps.vault;
    if (!vault) return null;
    const key = `${p.tenantId}:${p.userId}:${provider}`;
    const cached = this.credentials.get(key);
    if (cached !== undefined) return cached;
    const credential = await this.loadCredential(vault, p, provider);
    this.credentials.set(key, credential);
    return credential;
  }

  async policy(p: GatewayPrincipal): Promise<ModelPolicy> {
    const settings = await this.deps.settings.resolve({ tenantId: p.tenantId, userId: p.userId });
    const allowed = settings.values["models.allowed"] as string[] | undefined;
    return {
      allowed: allowed ?? [],
      byokEnabled: settings.values["byok.enabled"] !== false && !!this.deps.vault,
      poolForDirect: settings.values["pool.forDirect"] === true,
    };
  }

  async checkQuota(p: GatewayPrincipal): Promise<void> {
    const key = `${p.tenantId}:${p.userId}`;
    let exceeded = this.quotas.get(key);
    if (exceeded === undefined) {
      exceeded = await this.deps.config.quotaExceeded(p.tenantId, p.userId);
      this.quotas.set(key, exceeded);
    }
    if (exceeded) throw new ModelError(exceeded, QUOTA_EXCEEDED_STATUS, false);
  }

  recordUsage(u: UsageRecord): void {
    this.deps.telemetry.recordUsage({
      tenantId: u.tenantId,
      userId: u.userId,
      sessionId: u.sessionId,
      modelRequested: u.modelRequested,
      modelUsed: u.modelUsed,
      keySource: u.keySource,
      input: u.tokens.input ?? 0,
      output: u.tokens.output ?? 0,
      reasoning: u.tokens.reasoning ?? 0,
      cacheRead: u.tokens.cacheRead ?? 0,
      cacheWrite: u.tokens.cacheWrite ?? 0,
      costUsd: u.costUsd,
      latencyMs: u.latencyMs,
      status: u.status,
      time: u.time,
    });
  }

  invalidate(tenantId: string): void {
    this.credentials.deletePrefix(`${tenantId}:`);
    this.quotas.deletePrefix(`${tenantId}:`);
  }

  private async loadCredential(
    vault: KeyVault,
    p: GatewayPrincipal,
    provider: string,
  ): Promise<Credential | null> {
    const owner = { tenantId: p.tenantId, userId: p.userId };
    const row = await this.deps.config.findKey(owner, provider);
    if (!row) return null;
    const secret = await vault.decrypt(p.tenantId, row);
    const settings = await this.deps.settings.resolve(owner);
    const source: KeySource = row.ownerScope === "user" ? "byok_user" : "byok_tenant";
    const credential =
      provider === "bedrock"
        ? bedrockCredential(secret, settings.values["providers.bedrock.region"], source)
        : apiKeyCredential(secret, settings.values[`providers.${provider}.baseURL`], source);
    // Last-used bookkeeping only; a failed touch must never fail the model call.
    void this.deps.config.touchKey(p.tenantId, row.id).catch(() => {});
    return credential;
  }
}

// ---------- helpers ----------
function bedrockCredential(secret: string, regionSetting: unknown, source: KeySource): Credential {
  const region = String(regionSetting ?? DEFAULT_BEDROCK_REGION);
  const keyPair = secret.match(AWS_KEY_PAIR);
  if (!keyPair) return { key: secret, region, source };
  return { aws: { accessKeyId: keyPair[1], secretAccessKey: keyPair[2] }, region, source };
}

function apiKeyCredential(secret: string, baseURL: unknown, source: KeySource): Credential {
  if (typeof baseURL !== "string") return { key: secret, source };
  return { key: secret, source, baseURL };
}
