// Router — BYOK multi-provider, Bedrock first. Same context pipeline for every
// provider: system prompt (CLAUDE.md) + session + tools are built ONCE; this
// module only resolves { model, provider, endpoint, key } + fallback chain.
// Rule: retry on 429/5xx ONLY if no mutating tool ran yet (no double-execute).
// Types live in ./router/types.ts.
import configJson from "../agent.config.json";
import { defaultBedrock, type BedrockClient } from "./router/bedrock.js";
import { defaultCatalog, type ProviderCatalog } from "./router/providers.js";
import { defaultKeystore, type Keystore } from "./router/keystore.js";
import type { JevClient } from "./router/typesafe.js";
import type { ProviderId, ResolvedRoute, RouterConfig, Strategy } from "./router/types.js";

export class ModelRouter {
  constructor(
    private readonly catalog: ProviderCatalog = defaultCatalog,
    private readonly keystore: Keystore = defaultKeystore,
    private readonly bedrock: BedrockClient = defaultBedrock,
    private readonly cfg: RouterConfig = configJson as RouterConfig,
    private readonly jev: JevClient | null = null,
  ) {}

  private strategy(): Strategy {
    const s = this.cfg.routing?.strategy;
    if (s === "always-openrouter" || s === "direct-only" || s === "direct-if-key-else-openrouter") return s;
    return "direct-if-key-else-openrouter";
  }

  private directRoute(model: string, provider: ProviderId): ResolvedRoute {
    this.keystore.requireKey(provider); // throws with setup instructions when creds missing
    const directModel = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
    if (provider === "bedrock") {
      const region = this.keystore.bedrockRegion();
      return { model, directModel, provider, endpoint: this.bedrock.endpoint(region), via: "direct", region };
    }
    return { model, directModel, provider, endpoint: this.catalog.getProvider(provider).baseURL, via: "direct" };
  }

  resolveRoute(model: string): ResolvedRoute {
    const s = this.strategy();
    const prefix = this.catalog.prefixOf(model);
    const direct = this.catalog.directProviderFor(prefix);

    // Bedrock slugs (bedrock/<bedrock-model-id>) only exist on Bedrock —
    // never send them to an aggregator. Throws the Bedrock setup hint when creds miss.
    if (prefix === "bedrock") return this.directRoute(model, "bedrock");

    if (s === "direct-only") {
      if (!direct) throw new Error(`no direct provider for "${model}" — use a bedrock/... slug or set OPENROUTER_API_KEY`);
      return this.directRoute(model, direct);
    }
    if (direct && s === "direct-if-key-else-openrouter" && this.keystore.hasKey(direct)) {
      return this.directRoute(model, direct);
    }
    // Aggregator path (also the explicit "always-openrouter" strategy).
    this.keystore.requireKey("openrouter");
    return { model, directModel: model, provider: "openrouter", endpoint: this.catalog.getProvider("openrouter").baseURL, via: "openrouter" };
  }

  /** Primary model from ENV/default. When AGENT_MODEL_CHEAP + a Jev key exist,
   *  Jev picks cheap vs primary per message (fail-soft → primary). */
  async pickModelSmart(prompt: string): Promise<string> {
    const primary = process.env.AGENT_MODEL ?? this.cfg.model;
    const cheap = process.env.AGENT_MODEL_CHEAP?.trim();
    if (!cheap || cheap === primary || !this.jev?.isAvailable()) return primary;
    const r = await this.jev.decideSafe(prompt.slice(0, 2000), {
      effort: {
        type: "choice",
        instructions: "How much reasoning does this request need?",
        criteria: {
          trivial: "greetings, one-line facts, simple lookups, short rewrites",
          heavy: "multi-step coding, debugging, planning, long analysis, tool use",
        },
      },
    });
    const effort = r?.answers?.effort?.choice;
    const conf = r?.answers?.effort?.confidence ?? r?.answers?.effort?.probabilities?.[effort ?? ""] ?? 0;
    return effort === "trivial" && conf > 0.7 ? cheap : primary;
  }

  /** Primary model from ENV/default. */
  pickModel(_prompt: string): string {
    return process.env.AGENT_MODEL ?? this.cfg.model;
  }

  /** Full chain: primary + fallbacks, filtered to routes whose key exists. */
  routeChain(prompt: string): ResolvedRoute[] {
    const models = [this.pickModel(prompt), ...this.fallbacks()];
    const out: ResolvedRoute[] = [];
    for (const m of models) {
      try {
        const r = this.resolveRoute(m);
        this.keystore.requireKey(r.provider);
        if (!out.some((x) => x.model === r.model)) out.push(r);
      } catch {
        // skip models with no key — reported via /keys
      }
    }
    if (!out.length) {
      throw new Error(
        `no usable model: no provider keys set. Add at least one key in harness/.env. Available: ${this.keystore.availableProviders().join(", ") || "none"}`,
      );
    }
    return out;
  }

  fallbacks(): string[] {
    return (this.cfg.fallbacks ?? []).map((f) => f.model);
  }

  shouldRetry(status: number, mutatingToolRan: boolean): boolean {
    if (mutatingToolRan) return false;
    return status === 429 || (status >= 500 && status < 600);
  }

  /** One-line summary with NO secrets — safe for logs/TUI. */
  describeRoute(r: ResolvedRoute): string {
    return `${r.model} via ${r.provider} (${r.via}, ${r.endpoint}${r.region ? `, region=${r.region}` : ""})`;
  }
}

export const defaultRouter = new ModelRouter();

export function resolveRoute(model: string): ResolvedRoute {
  return defaultRouter.resolveRoute(model);
}

/** Primary model from ENV/default. */
export function pickModel(prompt: string): string {
  return defaultRouter.pickModel(prompt);
}

/** Full chain: primary + fallbacks, filtered to routes whose key exists. */
export function routeChain(prompt: string): ResolvedRoute[] {
  return defaultRouter.routeChain(prompt);
}

export function fallbacks(): string[] {
  return defaultRouter.fallbacks();
}

export function shouldRetry(status: number, mutatingToolRan: boolean): boolean {
  return defaultRouter.shouldRetry(status, mutatingToolRan);
}

/** One-line summary with NO secrets — safe for logs/TUI. */
export function describeRoute(r: ResolvedRoute): string {
  return defaultRouter.describeRoute(r);
}
