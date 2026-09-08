import { canonicalize } from "@klaxon/core";
import { isUniqueViolation, type ReleaseRow } from "../db/index.js";
import type { CheckDeps, CheckFail, ReleaseAttempt } from "./types.js";
import { fail } from "./types.js";

/**
 * Checks 8, 9 and 7, in that order, under one `BEGIN IMMEDIATE` (A §5.3). They are grouped because
 * each of them is a race if read outside a write transaction: two concurrent releases could both
 * see "not revoked", both see "budget available", or both insert the same `h`.
 *
 * The insert *is* check 9. Single-use is the primary key on `h`, not a `SELECT` before it.
 */
export class AtomicRefusal extends Error {
  readonly failure: CheckFail;
  constructor(failure: CheckFail) {
    super(`${failure.class}/${failure.check}: ${failure.reason}`);
    this.name = "AtomicRefusal";
    this.failure = failure;
  }
}

export type AtomicOutcome =
  | { kind: "released"; outboxId: number }
  /** Same `h`, same `pay_tx`, same `C`: a retry of a release that already happened (A §5.4). */
  | { kind: "idempotent"; row: ReleaseRow };

export interface AtomicArgs {
  attempt: ReleaseAttempt;
  /** Built by the caller so the envelope is written inside the same transaction as the decision. */
  releasedEnvelope: unknown;
}

export function runAtomicChecks(deps: CheckDeps, args: AtomicArgs): AtomicOutcome {
  const { attempt } = args;
  const now = deps.clock().toISOString();

  // ---- check 8: revocation, read authoritatively inside the transaction ----
  const project = deps.repos.projects.get(attempt.project.project_id);
  if (!project) throw new AtomicRefusal(fail("auth", 0, "project is not registered"));
  if (project.revoked !== 0) {
    throw new AtomicRefusal(fail("policy", 8, "project is revoked"));
  }
  if (project.local_epoch !== project.chain_epoch) {
    throw new AtomicRefusal(
      fail(
        "policy",
        8,
        `local epoch ${project.local_epoch} has not been cleared on chain (chain epoch ${project.chain_epoch})`,
      ),
    );
  }

  // ---- check 9: h is unused ----
  const canonicalC = canonicalize(attempt.C);
  try {
    deps.repos.releases.insert({
      h: attempt.h,
      project_id: project.project_id,
      secret: attempt.C.secret,
      gen: Number(attempt.C.gen),
      environment: attempt.C.environment,
      run_id: attempt.C.run_id,
      run_attempt: attempt.C.run_attempt,
      commitment_json: canonicalC,
      jwt: attempt.body.jwt,
      sig: attempt.body.sig,
      pay_tx: attempt.payTx,
      created_at: now,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = deps.repos.releases.get(attempt.h);
    if (existing && existing.pay_tx === attempt.payTx && existing.commitment_json === canonicalC) {
      // The runner retried after a dropped response. Re-seal B from the same inputs; that payment
      // already has exactly one `released` message and must not get a second.
      return { kind: "idempotent", row: existing };
    }
    if (existing) {
      throw new AtomicRefusal(fail("policy", 9, "commitment hash h has already been released"));
    }
    // No row for this h, so the collision was the unique index on pay_tx: one payment, two
    // different commitments.
    throw new AtomicRefusal(
      fail("policy", 9, "this payment has already been spent on a different commitment"),
    );
  }

  // ---- check 7: budget. A rate limit, not an attack signal — refuse WITHOUT revoking (D16) ----
  const used = deps.repos.releases.countForGeneration(
    project.project_id,
    attempt.C.secret,
    Number(attempt.C.gen),
  );
  if (used > project.max_releases) {
    throw new AtomicRefusal(
      fail(
        "policy",
        7,
        `release budget exhausted for ${attempt.C.secret} gen ${attempt.C.gen} (${project.max_releases} allowed)`,
      ),
    );
  }

  // The decision and the intent to publish are one atomic write (D23).
  const outboxId = deps.repos.outbox.enqueue(
    project.topic_id,
    "released",
    args.releasedEnvelope,
    now,
  );
  deps.repos.releases.linkOutbox(attempt.h, outboxId);
  return { kind: "released", outboxId };
}
