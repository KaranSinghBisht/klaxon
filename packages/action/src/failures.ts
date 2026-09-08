import { KlaxonError, type ReleaseRefused } from "@klaxon/core";

export interface FailureContext {
  /** The structured refusal body, when the witness answered `{ok:false}`. */
  refusal: ReleaseRefused | null;
  /** The runner's Hedera account, named when the failure looks like a payment problem. */
  payAccount?: string;
}

const ID_TOKEN_HINT = "ACTIONS_ID_TOKEN_REQUEST";

/** `@actions/core` throws a bare env-var message here; it is the single most common setup mistake. */
const ID_TOKEN_MESSAGE =
  "KLAXON: missing id-token: write permission — add `permissions: { id-token: write }` to the job";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The witness now reports revocation outright; a witness that does not send the field still implies
 * it, because class `policy` revokes except for check 7, the release budget (PROTOCOL §6, D16).
 */
function wasRevoked(r: ReleaseRefused): boolean {
  return r.revoked ?? (r.class === "policy" && r.check !== 7);
}

function describeRefusal(r: ReleaseRefused): string {
  if (r.class === "infra") {
    // Infra never publishes to HCS and never revokes, so there is nothing further to cite.
    return `KLAXON: witness could not complete the release (check ${r.check}: ${r.reason} · commitment ${r.h}) — fail closed, retry`;
  }
  const record = r.hcs ? ` · on the record: HCS #${r.hcs.sequence_number}` : "";
  const revoked = wasRevoked(r) ? " · project revoked" : "";
  return `KLAXON: refused (${r.class}, check ${r.check}): ${r.reason} · commitment ${r.h}${record}${revoked}`;
}

function looksLikePaymentFailure(msg: string): boolean {
  return /payment|402|INSUFFICIENT|spend control|allowedAssets/i.test(msg);
}

/**
 * Turns whatever went wrong into the one line `core.setFailed` prints (B §1.6). Never includes a
 * stack, the share, or the plaintext — a bad share is a witness-compromise signal, not something to
 * dump into the job log.
 */
export function describeFailure(err: unknown, ctx: FailureContext): string {
  const msg = messageOf(err);
  if (msg.includes(ID_TOKEN_HINT)) return ID_TOKEN_MESSAGE;

  if (ctx.refusal) return describeRefusal(ctx.refusal);

  if (err instanceof KlaxonError && err.code === "WITNESS_BAD_SHARE") {
    return "KLAXON: witness returned a bad share";
  }
  if (err instanceof KlaxonError && err.code === "LKRP_RESTORE_FAILED") {
    return `KLAXON: could not restore the wallet-sync key from Ledger (${msg}) — fail closed, retry`;
  }
  if (looksLikePaymentFailure(msg)) {
    const who = ctx.payAccount ? ` from ${ctx.payAccount}` : "";
    return `KLAXON: payment failed${who} (${msg}) — check the account's HBAR balance and max-tinybars; fail closed, retry`;
  }
  // Errors raised inside this package already name KLAXON; don't say it twice.
  return msg.startsWith("KLAXON: ") ? msg : `KLAXON: ${msg}`;
}
