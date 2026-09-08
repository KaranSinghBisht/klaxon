import type { PaymentRequirements, SettleResponse } from "@x402/core/types";

/**
 * Everything the witness needs from x402 + the mirror node. The real implementation is
 * `adapters/payment-x402.ts`; tests inject a fake so no unit test touches the network.
 */

/** The body and header of a 402 answer, already encoded by the x402 SDK. */
export interface PaymentRequiredAnswer {
  /** The `PaymentRequired` object — served as the 402 JSON body. */
  body: unknown;
  /** Value for the `PAYMENT-REQUIRED` response header. */
  header: string;
  /** The `accepts` list, kept so `POST` can match a payload against what `GET` advertised. */
  requirements: PaymentRequirements[];
}

export type SettleOutcome =
  | {
      ok: true;
      /** `settle.transaction` — the Hedera transaction id. This is `pay_tx`. */
      payTx: string;
      payer: string | undefined;
      /** Value for the `PAYMENT-RESPONSE` response header. */
      responseHeader: string;
      settle: SettleResponse;
    }
  /** The client's payment is bad: no payment happened, answer 402. */
  | { ok: false; infra: false; reason: string }
  /** The facilitator or Hedera is unwell: 503, never a refusal, never a revoke. */
  | { ok: false; infra: true; reason: string };

export interface OnChainExpectation {
  /** The transaction memo must decode to exactly this — the commitment hash. */
  memo: string;
  /** The witness account that must be credited. */
  toAccount: string;
  /** Minimum tinybars credited to `toAccount`. */
  minAmount: string;
}

/**
 * The `infra` discriminator is load-bearing (A §5.7): it is the single thing that keeps a mirror
 * node timeout from revoking a project. Never collapse these two false cases into one.
 */
export type OnChainOutcome =
  | { ok: true; consensusTimestamp: string; payerAccount: string; amount: string }
  | { ok: false; infra: false; reason: string }
  | { ok: false; infra: true; reason: string };

export interface PaymentPort {
  /** Build the 402 for `/release/:h`, with `extra.memo = h` (B §2.2, D11). */
  buildRequirements(h: string): Promise<PaymentRequiredAnswer>;
  /** Verify then settle a `PAYMENT-SIGNATURE` header against the requirements for `h`. */
  verifyAndSettle(h: string, paymentSignatureHeader: string): Promise<SettleOutcome>;
  /** Check 1: read the settled transaction back from the mirror node (B §2.3 step 4). */
  verifySettledOnChain(payTx: string, expect: OnChainExpectation): Promise<OnChainOutcome>;
  /** `/health`: is the facilitator reachable and did `initialize()` succeed; is the mirror up. */
  health(): Promise<{ facilitator: boolean; mirror: boolean }>;
  /** The advertised price, surfaced by the manifest (PROTOCOL §4). */
  price(): { amount: string; asset: string; network: string };
}
