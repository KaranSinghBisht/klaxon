import type { CheckDeps, CheckFail, ReleaseAttempt } from "./types.js";
import { fail, pass } from "./types.js";

/**
 * Check 1 — the payment actually settled on Hedera, carries `h` as its memo, credited the witness
 * with at least the advertised price, and was debited from the account this project registered
 * (PROTOCOL §6.1). The mirror node is the source of truth, not the facilitator's word: this is the
 * same public data `verify` re-reads with no witness involvement.
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

  // The price floor is asserted here as well as passed down: `minAmount` is what the port was
  // *asked* to enforce, `amount` is what it read back off the chain, and the check that owns the
  // price is the one that must compare them. Otherwise a 1 tinybar transfer carrying a valid memo
  // is a release attempt nobody paid for.
  const credited = tinybars(settled.amount);
  if (credited === null) {
    return fail("infra", 1, "mirror node returned an unparseable transfer amount");
  }
  if (credited < BigInt(deps.config.X402_PRICE_TINYBAR)) {
    return fail(
      "auth",
      1,
      `payment credited ${settled.amount} tinybars, short of the advertised ${deps.config.X402_PRICE_TINYBAR}`,
    );
  }

  // The debit side of the transfer list is the runner; the facilitator pays the network fee, so
  // `payer_account_id` names Blocky402 and never the payer (PROTOCOL §5). Without this comparison
  // *any* funded Hedera account can buy anyone's release — `h` is public the moment the commitment
  // is, and the memo is the only thing that binds a transfer to a commitment.
  //
  // `pay_account` is null for a project registered before the binding existed. Those are skipped
  // rather than refused: an operator who never named a payer cannot be in breach of one.
  const registered = attempt.project.pay_account;
  if (registered && settled.payerAccount !== registered) {
    return fail(
      "policy",
      1,
      `payment was debited from ${settled.payerAccount || "an account the transfer list does not name"}, not the project's registered payer ${registered}`,
    );
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

/** Tinybars are integers. Parsed as one, never as a float — a float rounds the price comparison. */
function tinybars(amount: string): bigint | null {
  const value = amount.trim();
  return /^\d+$/.test(value) ? BigInt(value) : null;
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
