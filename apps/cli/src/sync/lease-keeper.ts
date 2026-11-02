// Holds the server-side session lease: acquire, renew in the background, release on close.

import type { ExaApi } from "../services/api.service.ts";

// ---------- constants ----------
const DEFAULT_TTL_MS = 60_000;
/** Renew this many times per TTL so one missed renewal doesn't lose the lease. */
const RENEWALS_PER_TTL = 3;
const HTTP_CONFLICT = 409;

// ---------- lease keeper ----------
export class LeaseKeeper {
  fencing = 0;
  lost = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly api: ExaApi,
    private readonly sessionId: string,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly onLost: () => void = () => {},
  ) {}

  async acquire(): Promise<void> {
    const r = await this.api.lease(this.sessionId, "acquire", undefined, this.ttlMs);
    this.fencing = r.fencing;
    this.lost = false;
    this.timer = setInterval(() => this.renew(), Math.floor(this.ttlMs / RENEWALS_PER_TTL));
    (this.timer as { unref?: () => void }).unref?.();
  }

  async release(): Promise<void> {
    this.stopTimer();
    if (!this.fencing || this.lost) return;
    // best effort: the lease expires on its own if the server can't be reached
    await this.api.lease(this.sessionId, "release", this.fencing).catch(() => {});
  }

  /** A 409 means another client took the lease; other errors are retried on the next tick. */
  private async renew(): Promise<void> {
    try {
      await this.api.lease(this.sessionId, "renew", this.fencing, this.ttlMs);
    } catch (e) {
      if ((e as { status?: number }).status === HTTP_CONFLICT) {
        this.lost = true;
        this.stopTimer();
        this.onLost();
      }
    }
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
