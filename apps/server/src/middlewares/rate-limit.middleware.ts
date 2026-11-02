// Rate limiting: fixed-window per-key limits for sign-in attempts (per IP), regular API calls
// (per user) and the chatty live-sync endpoints (per user, much higher).
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { HttpError } from "../models/http-error.model.ts";

// ---------- constants ----------
const RATE_WINDOW_MS = 60_000;
const AUTH_REQUESTS_PER_WINDOW = 30;
const API_REQUESTS_PER_WINDOW = 600;
/** Live sync (event ingest, SSE, model streaming, authorize) is chatty by design. */
const SYNC_REQUESTS_PER_WINDOW = 6000;
const SYNC_PATH_SUFFIX = /\/(ingest|events|lease)$/;
const SYNC_PATHS = new Set(["/v1/model/stream", "/v1/authorize"]);
const AUTH_PATH_PREFIX = "/v1/auth/";
/** Rate-limiter buckets are pruned of expired windows once the map grows past this. */
const RATE_LIMIT_PRUNE_THRESHOLD = 50_000;

// ---------- rate limit middleware ----------
export class RateLimitMiddleware {
  private readonly auth = new RateLimiter(AUTH_REQUESTS_PER_WINDOW, RATE_WINDOW_MS);
  private readonly api = new RateLimiter(API_REQUESTS_PER_WINDOW, RATE_WINDOW_MS);
  private readonly sync = new RateLimiter(SYNC_REQUESTS_PER_WINDOW, RATE_WINDOW_MS);

  /** Sign-in endpoints are limited per client IP, before any authentication. */
  checkAnonymous(pathname: string, ip: string): void {
    if (pathname.startsWith(AUTH_PATH_PREFIX))
      enforce(this.auth, `auth:${ip}`, "too many attempts");
  }

  /** Authenticated calls are limited per user; live-sync paths have their own bucket. */
  checkUser(pathname: string, userId: string): void {
    if (isSyncPath(pathname)) enforce(this.sync, `s:${userId}`, "rate limit exceeded");
    else enforce(this.api, `u:${userId}`, "rate limit exceeded");
  }
}

/** Fixed-window per-key rate limiter (in-process; good enough per node). */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): { ok: boolean; retryAfter: number } {
    const now = Date.now();
    let window = this.hits.get(key);
    if (!window || window.reset <= now) {
      window = { n: 0, reset: now + this.windowMs };
      this.hits.set(key, window);
      if (this.hits.size > RATE_LIMIT_PRUNE_THRESHOLD) this.pruneExpired(now);
    }
    window.n++;
    return { ok: window.n <= this.limit, retryAfter: Math.ceil((window.reset - now) / 1000) };
  }

  private pruneExpired(now: number): void {
    for (const [key, window] of this.hits) if (window.reset <= now) this.hits.delete(key);
  }
}

// ---------- helpers ----------
function isSyncPath(pathname: string): boolean {
  return SYNC_PATH_SUFFIX.test(pathname) || SYNC_PATHS.has(pathname);
}

function enforce(limiter: RateLimiter, key: string, message: string): void {
  const result = limiter.check(key);
  if (result.ok) return;
  throw new HttpError(429, message, ERROR_CODES.rateLimited, { retryAfter: result.retryAfter });
}
