// The `exa` virtual model: classify the request into a tier, then try that tier's backends in
// order of health/priority, falling back across backends (and tiers) on failures that happen
// before any output was produced. Backends are config, never hard-wired.
import { type ModelChunk, ModelError, type ModelRequest, type Tier } from "@exa/protocol";
import { streamDirect } from "../gateway/direct.ts";
import type { FetchFn } from "../models/adapter.model.ts";
import type { Credential } from "../providers/provider-catalog.ts";
import { BackendHealth } from "./backend-health.ts";
import { type Backend, DEFAULT_BACKENDS } from "./backends.ts";
import { approxTokens, classify } from "./classifier.ts";

// ---------- constants ----------
const TIER_FALLBACK: Record<Tier, Tier[]> = {
  fast: ["fast", "balanced", "strong"],
  balanced: ["balanced", "strong", "fast"],
  strong: ["strong", "balanced"],
};

/** Leave headroom in each backend's context window for the reply. */
const CONTEXT_HEADROOM = 0.9;
/** How much of each backend's error goes into the combined "all failed" message. */
const ERROR_SNIPPET_CHARS = 200;
const UNAVAILABLE_STATUS = 503;

// ---------- types ----------
export interface ExaRouterOpts {
  backends?: Backend[];
  credential: (provider: string) => Credential | null;
  fetch?: FetchFn;
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

type BackendStatus = Backend & {
  healthy: boolean;
  available: boolean;
  ewmaMs: number;
  ok: number;
  err: number;
};

/** One try of one backend; once it has produced output it can't fall back. */
interface Attempt {
  backend: Backend;
  cred: Credential;
  started: number;
  produced: boolean;
}

// ---------- router ----------
export class ExaRouter {
  private backends: Backend[];
  private readonly health: BackendHealth;
  private readonly now: () => number;

  constructor(private readonly opts: ExaRouterOpts) {
    this.backends = enabledOnly(opts.backends ?? DEFAULT_BACKENDS);
    this.now = opts.now ?? Date.now;
    this.health = new BackendHealth({
      failureThreshold: opts.failureThreshold,
      cooldownMs: opts.cooldownMs,
      now: this.now,
    });
  }

  setBackends(b: Backend[]): void {
    this.backends = enabledOnly(b);
  }

  /** Backends usable for this request, best first. */
  candidates(req: ModelRequest, tier: Tier): Backend[] {
    const need = approxTokens(req);
    const out: Backend[] = [];
    for (const t of TIER_FALLBACK[tier]) {
      const tierList = this.backends
        .filter((b) => b.tier === t)
        .filter((b) => !req.tools?.length || b.supportsTools)
        .filter((b) => need < b.contextWindow * CONTEXT_HEADROOM)
        .filter((b) => this.opts.credential(b.provider) !== null)
        .sort((a, b) => this.compareBackends(a, b));
      out.push(...tierList);
    }
    return out;
  }

  status(): BackendStatus[] {
    return this.backends.map((b) => {
      const h = this.health.get(b.id);
      return {
        ...b,
        healthy: h.openUntil <= this.now(),
        available: this.opts.credential(b.provider) !== null,
        ewmaMs: Math.round(h.ewmaMs),
        ok: h.ok,
        err: h.err,
      };
    });
  }

  async *stream(
    req: ModelRequest,
    signal: AbortSignal,
    explicitTier?: Tier,
  ): AsyncGenerator<ModelChunk> {
    const tier = classify(req, explicitTier);
    const list = this.candidates(req, tier);
    if (!list.length) throw noBackendError(tier, req);
    const errors: string[] = [];
    for (const b of list) {
      if (signal.aborted) return;
      const cred = this.opts.credential(b.provider) as Credential;
      const attempt: Attempt = { backend: b, cred, started: this.now(), produced: false };
      try {
        yield* this.streamBackend(attempt, req, signal);
        return;
      } catch (e) {
        if (signal.aborted) return;
        const err = toModelError(e);
        this.health.recordFailure(b.id);
        errors.push(`${b.id}: ${err.message.slice(0, ERROR_SNIPPET_CHARS)}`);
        // Once output streamed, we can't transparently switch backends.
        if (attempt.produced) throw err;
        // Auth/validation errors on one backend don't imply the next will fail; keep going.
      }
    }
    throw new ModelError(
      `exa: all backends failed for tier "${tier}": ${errors.join(" | ")}`,
      UNAVAILABLE_STATUS,
      true,
    );
  }

  /** Healthy first, then lower priority number, then faster. */
  private compareBackends(a: Backend, b: Backend): number {
    const openA = this.health.isOpen(a.id) ? 1 : 0;
    const openB = this.health.isOpen(b.id) ? 1 : 0;
    const ewmaA = this.health.get(a.id).ewmaMs;
    const ewmaB = this.health.get(b.id).ewmaMs;
    return openA - openB || a.priority - b.priority || ewmaA - ewmaB;
  }

  /** Stream one backend; in-band error chunks become thrown ModelErrors. */
  private async *streamBackend(
    attempt: Attempt,
    req: ModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelChunk> {
    const { backend: b, cred } = attempt;
    const chunks = streamDirect(b.provider, b.model, req, cred, signal, this.opts.fetch);
    for await (const c of chunks) {
      if (c.type === "error") throw new ModelError(c.message, c.status ?? 0, c.retryable ?? true);
      if (c.type !== "start") attempt.produced = true;
      if (c.type === "finish") this.health.recordSuccess(b.id, this.now() - attempt.started);
      yield c;
    }
  }
}

// ---------- helpers ----------
function enabledOnly(backends: Backend[]): Backend[] {
  return backends.filter((b) => b.enabled !== false);
}

function toModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  return new ModelError(String((e as Error)?.message ?? e), 0, true);
}

function noBackendError(tier: Tier, req: ModelRequest): ModelError {
  const toolNote = req.tools?.length ? " with tool support" : "";
  return new ModelError(
    `exa: no backend available for tier "${tier}"${toolNote}. Configure provider keys for the platform pool (see docs) or pick a specific model with your own key.`,
    UNAVAILABLE_STATUS,
    false,
  );
}
