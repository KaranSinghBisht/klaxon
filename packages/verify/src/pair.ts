import type { AttemptRecord } from "./envelope.js";
import { type Finding, finding } from "./errors.js";
import { type Payment, txIdKey } from "./mirror/payments.js";
import { addSeconds, cmpTs, nowTs, parseTs } from "./timestamp.js";

/** B §3.5: the mirror node lags consensus by ~1–2 s; without a grace window the demo shows a false WITHHELD. */
export const DEFAULT_GRACE_SECONDS = 30;

export interface Pairing {
  payment: Payment;
  released: AttemptRecord[];
  refused: AttemptRecord[];
  /** Operator break-glass recoveries (PROTOCOL §7): paired exactly like a `released`. */
  emergency: AttemptRecord[];
  /** True while the payment is still inside the grace window and silence is not yet a verdict. */
  pending: boolean;
  withheld: boolean;
}

export interface PairResult {
  pairs: Pairing[];
  /** `released`/`refused` messages whose `pay_tx` matched no settled payment in the window. */
  orphans: AttemptRecord[];
  findings: Finding[];
}

export interface PairOptions {
  graceSeconds?: number;
  /** Wall clock; injected in tests so the grace window is deterministic. */
  now?: Date;
}

/**
 * PROTOCOL §9. Pairing is by `pay_tx`, not by `h`: a payment is the thing the runner can prove
 * it made, so it is the thing the witness must be made to answer for. Exactly one release per
 * payment — a `released` from the witness or an `emergency` from the operator's laptop, never
 * two of either; any number of `refused` (a client may legitimately retry after an `auth`
 * refusal on the same settled payment, A §6.3); silence past the grace window is the headline
 * finding.
 */
export function pairPayments(
  payments: readonly Payment[],
  attempts: readonly AttemptRecord[],
  options: PairOptions = {},
): PairResult {
  const grace = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const now = nowTs(options.now ?? new Date());
  const findings: Finding[] = [];

  const byPayment = new Map<string, AttemptRecord[]>();
  for (const attempt of attempts) {
    const list = byPayment.get(attempt.payTxKey);
    if (list) list.push(attempt);
    else byPayment.set(attempt.payTxKey, [attempt]);
  }

  const pairs: Pairing[] = [];
  const claimed = new Set<string>();

  for (const payment of payments) {
    const key = txIdKey(payment.transactionId);
    claimed.add(key);
    const matched = byPayment.get(key) ?? [];
    const released = matched.filter((m) => m.type === "released");
    const refused = matched.filter((m) => m.type === "refused");
    const emergency = matched.filter((m) => m.type === "emergency");
    // A break-glass recovery answers its payment as fully as a release does.
    const answers = [...released, ...emergency];
    const paymentTs = parseTs(payment.consensusTimestamp);
    const pending = matched.length === 0 && cmpTs(now, addSeconds(paymentTs, grace)) < 0;
    const withheld = matched.length === 0 && !pending;

    if (withheld) {
      findings.push(
        finding(
          "WITNESS_WITHHELD",
          `payment settled with memo ${payment.memo} and nothing was published on the topic within ${grace}s`,
          { h: payment.memo, pay_tx: payment.transactionId, at: payment.consensusTimestamp },
        ),
      );
    }
    if (answers.length > 1) {
      findings.push(
        finding(
          "DOUBLE_RELEASE",
          `${answers.length} release messages for one payment (${answers
            .map((r) => `${r.type} ${r.h}`)
            .join(", ")})`,
          { h: payment.memo, pay_tx: payment.transactionId, at: payment.consensusTimestamp },
        ),
      );
    }
    for (const attempt of matched) {
      if (cmpTs(parseTs(attempt.consensusTimestamp), paymentTs) < 0) {
        findings.push(
          finding(
            "ORDERING",
            `${attempt.type} reached consensus at ${attempt.consensusTimestamp}, before its payment at ${payment.consensusTimestamp}`,
            { h: attempt.h, pay_tx: payment.transactionId, at: attempt.consensusTimestamp },
          ),
        );
      }
    }

    pairs.push({ payment, released, refused, emergency, pending, withheld });
  }

  const orphans: AttemptRecord[] = [];
  for (const [key, list] of byPayment) {
    if (claimed.has(key)) continue;
    for (const attempt of list) {
      orphans.push(attempt);
      if (attempt.type === "refused") continue;
      findings.push(
        finding(
          "RELEASE_WITHOUT_PAYMENT",
          attempt.payTx === ""
            ? `${attempt.type} ${attempt.h} carries no pay_tx — the recovery left no on-chain record`
            : `${attempt.type} ${attempt.h} cites pay_tx ${attempt.payTx}, which is not a settled transfer to the witness in the scanned window`,
          { h: attempt.h, pay_tx: attempt.payTx, at: attempt.consensusTimestamp },
        ),
      );
    }
  }

  return { pairs, orphans, findings };
}
