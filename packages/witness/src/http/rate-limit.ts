/**
 * A fixed-window request limiter for the release routes.
 *
 * The witness spends far more answering a release than it charges: publishing one audit record
 * costs three chunked HCS submits plus a record query, roughly 3.2M tinybar against 100,000 of
 * revenue. That asymmetry is deliberate — the record carries the runner's whole OIDC token so a
 * verifier needs nobody's permission to check it — but it makes an unmetered endpoint an
 * amplification vector: every refusal a stranger provokes costs the operator ~32x what it costs
 * them. Check 7's budget bounds successful releases per project and says nothing about refusals.
 *
 * In-process and per-instance on purpose. The witness is a single writer against one SQLite volume,
 * so a shared store would add a dependency to defend a deployment that does not exist yet. If this
 * ever runs as more than one instance, this needs to move behind a shared counter.
 */
export interface RateLimitOptions {
  /** Requests permitted per key per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  now?: () => number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window rolls over — the `retry-after` value. */
  retryAfterS: number;
}

export class FixedWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(opts: RateLimitOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  take(key: string): RateLimitVerdict {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(t);
      return { allowed: true, retryAfterS: 0 };
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      return { allowed: false, retryAfterS: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) };
    }
    return { allowed: true, retryAfterS: 0 };
  }

  /** Bounded memory: windows that have rolled over are dropped rather than accumulating per IP. */
  private sweep(t: number): void {
    for (const [key, entry] of this.hits) {
      if (t >= entry.resetAt) this.hits.delete(key);
    }
  }
}
