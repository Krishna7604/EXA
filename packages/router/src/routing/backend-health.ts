// Per-backend health for the `exa` router: a circuit breaker (opens after N consecutive
// failures, closes after a cooldown or the next success) plus an EWMA of successful latency.

// ---------- constants ----------
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
/** Weight of the previous EWMA value; the newest sample gets the rest. */
const EWMA_KEEP = 0.8;
const EWMA_SAMPLE = 0.2;

// ---------- types ----------
export interface Health {
  failures: number;
  openUntil: number;
  ewmaMs: number;
  ok: number;
  err: number;
}

export interface BackendHealthOpts {
  failureThreshold?: number;
  cooldownMs?: number;
  now: () => number;
}

// ---------- health tracker ----------
export class BackendHealth {
  private readonly health = new Map<string, Health>();
  private readonly threshold: number;
  private readonly cooldown: number;
  private readonly now: () => number;

  constructor(opts: BackendHealthOpts) {
    this.threshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldown = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = opts.now;
  }

  /** Health record for a backend, created on first use. */
  get(id: string): Health {
    let h = this.health.get(id);
    if (!h) {
      h = { failures: 0, openUntil: 0, ewmaMs: 0, ok: 0, err: 0 };
      this.health.set(id, h);
    }
    return h;
  }

  /** True while the breaker is open (backend recently failed too often). */
  isOpen(id: string): boolean {
    return this.get(id).openUntil > this.now();
  }

  recordSuccess(id: string, ms: number): void {
    const h = this.get(id);
    h.failures = 0;
    h.openUntil = 0;
    h.ok++;
    h.ewmaMs = h.ewmaMs ? h.ewmaMs * EWMA_KEEP + ms * EWMA_SAMPLE : ms;
  }

  recordFailure(id: string): void {
    const h = this.get(id);
    h.err++;
    h.failures++;
    if (h.failures >= this.threshold) h.openUntil = this.now() + this.cooldown;
  }
}
