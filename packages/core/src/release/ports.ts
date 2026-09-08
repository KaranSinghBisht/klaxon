import type { Commitment, EciesEnvelope, KlaxonMember } from "../schema.js";

/** Mints a GitHub OIDC token for `audience` — `@actions/core` `getIDToken` in the action, a fake issuer in tests. */
export type OidcProvider = (audience: string) => Promise<string>;

export interface ReleaseRequestBody {
  C: Commitment;
  jwt: string;
  sig: string;
}

export interface ReleaseOk {
  ok: true;
  h: string;
  share_b: EciesEnvelope;
  hcs: { sequence_number: string; consensus_timestamp: string };
}

export interface ReleaseRefused {
  ok: false;
  h: string;
  class: "auth" | "policy" | "infra";
  check: number;
  reason: string;
}

export type ReleaseResponse = ReleaseOk | ReleaseRefused;

/**
 * Performs `POST /release/:h` and handles payment. The x402 implementation (action) lets
 * `wrapFetchWithPayment` answer the 402 with a memo-stamped transfer and reads `pay_tx` from the
 * PAYMENT-RESPONSE header. Tests inject a fake. The witness learns `pay_tx` from settlement, so
 * the body never carries it.
 */
export interface ReleaseTransport {
  release(
    h: string,
    body: ReleaseRequestBody,
  ): Promise<{ status: number; body: ReleaseResponse; payTx: string }>;
}

/** Restores the wallet-sync key for a member — the real one calls Ledger's API; tests inject a constant. */
export type WsekRestorer = (member: KlaxonMember) => Promise<string>;
