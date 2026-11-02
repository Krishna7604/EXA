// Model gateway: the only path from any loop (client or server) to a model.
// Resolves the slug, enforces tenant model policy + quotas, picks credentials
// (user BYOK → tenant BYOK → platform pool), streams, and records usage.
import {
  type ModelChunk,
  ModelError,
  type ModelRequest,
  type Tier,
  type Tokens,
} from "@exa/protocol";
import type { FetchFn } from "../models/adapter.model.ts";
import type { GatewayPorts, ModelPolicy, Principal, UsageRecord } from "../models/gateway.model.ts";
import {
  type Credential,
  envCredential,
  getProvider,
  parseSlug,
} from "../providers/provider-catalog.ts";
import type { Backend } from "../routing/backends.ts";
import { ExaRouter } from "../routing/exa.router.ts";
import { streamDirect } from "./direct.ts";

// ---------- constants ----------
/** Providers offered in the model picker, in display order. */
const SELECTABLE_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "groq",
  "deepseek",
  "xai",
  "mistral",
  "together",
  "cerebras",
  "opencode",
  "bedrock",
];

const EXA_TIERS: readonly Tier[] = ["fast", "balanced", "strong"];

// ---------- types ----------
export interface GatewayOpts {
  ports: GatewayPorts;
  /** Platform pool credentials (server env). */
  pool?: Record<string, string | undefined>;
  backends?: Backend[];
  fetch?: FetchFn;
}

interface ProviderChoice {
  id: string;
  label: string;
  source: Credential["source"];
}

/** Everything one gateway request needs to resolve a model stream. */
interface StreamContext {
  principal: Principal;
  policy: ModelPolicy;
  req: ModelRequest;
  signal: AbortSignal;
}

interface OpenedStream {
  inner: AsyncGenerator<ModelChunk>;
  keySource: Credential["source"];
}

/** Usage facts gathered while a request streams; turned into a UsageRecord at the end. */
interface UsageTally {
  started: number;
  modelRequested: string;
  modelUsed: string;
  keySource: Credential["source"];
  tokens: Partial<Tokens>;
  cost: number;
  status: UsageRecord["status"];
}

// ---------- policy ----------
export function isModelAllowed(policy: ModelPolicy, slug: string): boolean {
  if (!policy.allowed?.length) return true;
  return policy.allowed.some((p) => wildcard(p, slug));
}

// ---------- gateway ----------
export class Gateway {
  readonly exa: ExaRouter;
  private readonly pool: Record<string, string | undefined>;

  constructor(private readonly opts: GatewayOpts) {
    this.pool = opts.pool ?? {};
    this.exa = new ExaRouter({
      backends: opts.backends,
      credential: (p) => envCredential(p, this.pool, "pool"),
      fetch: opts.fetch,
    });
  }

  /** Models a principal can pick: exa tiers + every provider they hold a key for. */
  async available(principal: Principal): Promise<{
    exa: boolean;
    providers: ProviderChoice[];
  }> {
    const policy = await this.opts.ports.policy(principal);
    const providers: ProviderChoice[] = [];
    for (const id of SELECTABLE_PROVIDERS) {
      const choice = await this.providerChoice(principal, policy, id);
      if (choice) providers.push(choice);
    }
    return {
      exa: this.exa.candidates({ model: "exa", system: "", messages: [] }, "balanced").length > 0,
      providers,
    };
  }

  async *stream(
    principal: Principal,
    req: ModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelChunk> {
    const slug = req.model;
    const policy = await this.opts.ports.policy(principal);
    assertModelAllowed(policy, slug);
    await this.opts.ports.checkQuota(principal);

    const tally = newTally(slug);
    try {
      const opened = await this.openStream({ principal, policy, req, signal });
      tally.keySource = opened.keySource;
      for await (const c of opened.inner) {
        trackChunk(tally, c);
        yield c;
      }
    } finally {
      if (signal.aborted) tally.status = "aborted";
      this.opts.ports.recordUsage(toUsageRecord(principal, req, tally));
    }
  }

  /** A provider entry for the picker, or null when the principal has no usable key. */
  private async providerChoice(
    principal: Principal,
    policy: ModelPolicy,
    id: string,
  ): Promise<ProviderChoice | null> {
    const def = getProvider(id)!;
    const byok = policy.byokEnabled ? await this.opts.ports.byok(principal, id) : null;
    if (byok) return { id, label: def.label, source: byok.source };
    if (policy.poolForDirect && envCredential(id, this.pool, "pool"))
      return { id, label: def.label, source: "pool" };
    return null;
  }

  private async openStream(ctx: StreamContext): Promise<OpenedStream> {
    const slug = ctx.req.model;
    if (isExaSlug(slug)) {
      const inner = this.exa.stream(ctx.req, ctx.signal, exaTier(slug));
      return { inner, keySource: "pool" };
    }
    return this.openDirect(ctx);
  }

  private async openDirect(ctx: StreamContext): Promise<OpenedStream> {
    const slug = ctx.req.model;
    const { provider, model } = parseSlug(slug);
    if (!getProvider(provider) || !model)
      throw new ModelError(
        `unknown model "${slug}" — use "exa" or "<provider>/<model>"`,
        400,
        false,
      );
    const cred = await this.directCredential(ctx, provider);
    const inner = streamDirect(provider, model, ctx.req, cred, ctx.signal, this.opts.fetch);
    return { inner, keySource: cred.source };
  }

  /** BYOK first (when enabled), then the platform pool (when allowed for direct models). */
  private async directCredential(ctx: StreamContext, provider: string): Promise<Credential> {
    const { principal, policy } = ctx;
    let cred = policy.byokEnabled ? await this.opts.ports.byok(principal, provider) : null;
    if (!cred && policy.poolForDirect) cred = envCredential(provider, this.pool, "pool");
    if (!cred) {
      throw new ModelError(
        `no API key for ${getProvider(provider)!.label}. Add your key (settings → keys, or \`exa keys add ${provider}\`) or use the "exa" model.`,
        401,
        false,
      );
    }
    return cred;
  }
}

/** Gateway ports for single-user local use (CLI direct mode): env keys, no quotas. */
export function localPorts(env: Record<string, string | undefined> = process.env): GatewayPorts {
  return {
    byok: async (_p, provider) => envCredential(provider, env, "env"),
    policy: async () => ({ byokEnabled: true, poolForDirect: false }),
    checkQuota: async () => {},
    recordUsage: () => {},
  };
}

// ---------- helpers ----------
function wildcard(p: string, v: string): boolean {
  const re = new RegExp(
    "^" +
      p
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return re.test(v);
}

function assertModelAllowed(policy: ModelPolicy, slug: string): void {
  if (isModelAllowed(policy, slug)) return;
  throw new ModelError(`model "${slug}" is not allowed by your organization's policy`, 403, false);
}

function isExaSlug(slug: string): boolean {
  return slug === "exa" || slug.startsWith("exa/");
}

/** "exa/strong" → "strong"; plain "exa" or an unknown suffix → undefined (auto-classify). */
function exaTier(slug: string): Tier | undefined {
  const tierPart = slug.split("/")[1] as Tier | undefined;
  return tierPart && EXA_TIERS.includes(tierPart) ? tierPart : undefined;
}

function newTally(slug: string): UsageTally {
  return {
    started: Date.now(),
    modelRequested: slug,
    modelUsed: slug,
    keySource: "pool",
    tokens: {},
    cost: 0,
    status: "error",
  };
}

function trackChunk(tally: UsageTally, c: ModelChunk): void {
  if (c.type === "start") tally.modelUsed = `${c.provider}/${c.model}`;
  if (c.type === "finish") {
    tally.tokens = c.usage;
    tally.cost = c.cost ?? 0;
    tally.status = "ok";
  }
}

function toUsageRecord(principal: Principal, req: ModelRequest, tally: UsageTally): UsageRecord {
  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    sessionId: principal.sessionId ?? req.sessionId,
    modelRequested: tally.modelRequested,
    modelUsed: tally.modelUsed,
    keySource: tally.keySource,
    tokens: tally.tokens,
    costUsd: tally.cost,
    latencyMs: Date.now() - tally.started,
    status: tally.status,
    time: Date.now(),
  };
}
