/**
 * The deadline every outbound call the witness makes runs under.
 *
 * undici's default headers timeout is 300 s, and there is no body timeout at all. One slow
 * upstream — the mirror node, raw.githubusercontent, ntfy, the facilitator — therefore pins a
 * Fastify connection for five minutes, and a release request that never answers is
 * indistinguishable from a witness that withheld. Ten seconds is far longer than any of these
 * normally take and far shorter than a runner's patience.
 *
 * A timeout is an outage, never a verdict: it surfaces as the same throw a dead socket produces,
 * so every caller's existing "transport threw ⇒ `infra`" branch covers it and the witness still
 * fails closed.
 */
export const OUTBOUND_TIMEOUT_MS = 10_000;

/**
 * `AbortSignal.timeout` rejects the fetch with a `TimeoutError` once `ms` have elapsed, covering
 * connect, headers and body — the whole call, not just the handshake.
 */
export function timeoutSignal(ms: number = OUTBOUND_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}
