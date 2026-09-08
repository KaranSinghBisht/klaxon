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

function describeRefusal(r: ReleaseRefused): string {
  const where = `check ${r.check}: ${r.reason} · commitment ${r.h}`;
  if (r.class === "infra") {
    return `KLAXON: witness could not complete the release (${where}) — fail closed, retry`;
  }
  // Class `policy` revokes the project (PROTOCOL §6); check 7 is the release budget and does not.
  const revoked = r.class === "policy" && r.check !== 7 ? " · the project is now revoked" : "";
  return `KLAXON: release refused (${r.class}, ${where})${revoked}`;
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
