import type { CheckDeps, CheckFail, ReleaseAttempt } from "./types.js";
import { fail, pass } from "./types.js";

/**
 * Check 1 — the payment actually settled on Hedera, carries `h` as its memo, and credited the
 * witness (PROTOCOL §6.1). The mirror node is the source of truth, not the facilitator's word:
 * this is the same public data `verify` re-reads with no witness involvement.
 *
 * A mirror node that is down is `infra` — 503, no HCS message, no revoke. Collapsing that into a
 * refusal would let a Hedera outage revoke every project on the box.
 */
export async function checkPayment(
  deps: CheckDeps,
  attempt: ReleaseAttempt,
): Promise<{ ok: true } | CheckFail> {
  const settled = await deps.payment.verifySettledOnChain(attempt.payTx, {
    memo: attempt.h,
    toAccount: deps.config.witnessAccount,
    minAmount: deps.config.X402_PRICE_TINYBAR,
  });

  if (!settled.ok) {
    return settled.infra
      ? fail("infra", 1, `payment could not be read back on chain: ${settled.reason}`)
      : fail("auth", 1, settled.reason);
  }

  const ageS = ageSeconds(attempt.now, settled.consensusTimestamp);
  if (ageS === null) {
    return fail("infra", 1, "mirror node returned an unparseable consensus timestamp");
  }
  if (ageS > deps.config.KLAXON_PAYMENT_MAX_AGE_S) {
    return fail(
      "auth",
      1,
      `stale payment: settled ${Math.round(ageS)}s ago, limit is ${deps.config.KLAXON_PAYMENT_MAX_AGE_S}s`,
    );
  }
  return pass();
}

/**
 * Hedera timestamps are `seconds.nanos` decimal strings. Parsed as integers, never as floats —
 * a float loses the nanosecond half and the ordering checks in `verify` depend on it.
 */
export function ageSeconds(now: Date, consensusTimestamp: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(consensusTimestamp);
  if (!m?.[1]) return null;
  const seconds = Number(m[1]);
  const nanos = Number((m[2] ?? "").padEnd(9, "0"));
  return now.getTime() / 1000 - (seconds + nanos / 1e9);
}
