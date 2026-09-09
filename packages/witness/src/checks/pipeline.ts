import {
  canonicalize,
  eciesSeal,
  type Policy,
  type ReleaseOk,
  type ReleaseRefused,
} from "@klaxon/core";
import type { Db, ProjectRow } from "../db/index.js";
import { immediateTransaction } from "../db/index.js";
import { refusedEnvelope, releasedEnvelope } from "../hcs/envelope.js";
import { publishOutboxId } from "../hcs/publish.js";
import type { HcsPort, RefusalAlarm, ReleaseAlarm } from "../ports/index.js";
import { deriveShareB } from "../shares/derive.js";
import { checkPayment } from "./c1-payment.js";
import { checkJwt } from "./c2-jwt.js";
import { checkCommitment } from "./c3-commitment.js";
import { checkPolicy } from "./c4-policy.js";
import { checkWorkflow } from "./c5-workflow.js";
import { checkSecretGeneration } from "./c6-secret-gen.js";
import { AtomicRefusal, runAtomicChecks } from "./c789-atomic.js";
import type { CheckDeps, CheckFail, OidcClaims, ReleaseAttempt } from "./types.js";
import { fail } from "./types.js";

export interface PipelineDeps extends CheckDeps {
  db: Db;
  hcs: HcsPort;
}

export type ReleaseOutcome =
  | { status: 200; body: ReleaseOk; alarm: ReleaseAlarm | null }
  | { status: 403; body: ReleaseRefused; alarm: RefusalAlarm | null }
  | { status: 503; body: ReleaseRefused; alarm: null };

export interface PipelineInput {
  h: string;
  body: ReleaseAttempt["body"];
  C: ReleaseAttempt["C"];
  payTx: string;
}

/** What `replayRelease` needs: everything but a payment, because it must not cause one. */
export type ReplayInput = Omit<PipelineInput, "payTx">;

/**
 * The release path, in the order A §5.3 fixes:
 *
 *   checks 1..6 (pure)
 *   BEGIN IMMEDIATE → 8, 9, 7 → outbox insert → COMMIT
 *   publish to HCS → await consensus
 *   return ECIES(ek.enc, B, h)
 *
 * Publish-then-return is the whole invariant: the record reaches consensus *before* the second
 * key share moves. Anything that would return B before the message exists is a bug, not an
 * optimisation.
 */
export async function runRelease(
  deps: PipelineDeps,
  input: PipelineInput,
): Promise<ReleaseOutcome> {
  const now = deps.clock();
  const project = deps.repos.projects.get(input.C.project_id);
  if (!project) {
    // Nothing to publish to and no policy to apply — the refusal exists only in the HTTP answer.
    return refusalWithoutTopic(input.h, fail("auth", 0, "project is not registered"));
  }

  const attempt: ReleaseAttempt = {
    h: input.h,
    body: input.body,
    C: input.C,
    payTx: input.payTx,
    project,
    now,
  };

  // Cheap early read; check 8 re-reads it authoritatively inside the transaction.
  if (project.revoked !== 0) {
    return await refuse(deps, attempt, null, fail("policy", 8, "project is revoked"));
  }

  const pure = await runPureChecks(deps, attempt);
  if (!pure.ok) return await refuse(deps, attempt, pure.claims, pure.failure);

  const envelope = releasedEnvelope({
    ts: now.toISOString(),
    projectId: project.project_id,
    h: attempt.h,
    C: attempt.C,
    jwt: attempt.body.jwt,
    sig: attempt.body.sig,
    payTx: attempt.payTx,
  });

  let outboxId: number;
  try {
    const atomic = immediateTransaction(deps.db, () =>
      runAtomicChecks(deps, { attempt, releasedEnvelope: envelope, policy: pure.policy }),
    );
    if (atomic.kind === "idempotent") {
      return await idempotentSuccess(deps, attempt, atomic.row);
    }
    outboxId = atomic.outboxId;
  } catch (err) {
    if (err instanceof AtomicRefusal) {
      return await refuse(deps, attempt, pure.claims, err.failure);
    }
    deps.log.error({ h: attempt.h, err }, "release transaction failed");
    return infraRefusal(attempt.h, fail("infra", 0, "release could not be recorded"));
  }

  const published = await publishOutboxId(
    { hcs: deps.hcs, outbox: deps.repos.outbox, log: deps.log },
    outboxId,
  );
  if (!published) {
    // The release row and its outbox entry survive; the drain job will publish it. B does not move
    // until that message exists, so the runner retries and takes the idempotent path.
    return infraRefusal(attempt.h, fail("infra", 0, "consensus record could not be published"));
  }
  deps.repos.releases.setConsensus(
    attempt.h,
    published.sequenceNumber,
    published.consensusTimestamp,
  );

  return {
    status: 200,
    alarm: releaseAlarm(deps, attempt, pure.claims),
    body: {
      ok: true,
      h: attempt.h,
      share_b: sealShareB(deps, attempt.project, attempt.C.secret, attempt.C.gen, attempt),
      hcs: {
        sequence_number: published.sequenceNumber,
        consensus_timestamp: published.consensusTimestamp,
      },
    },
  };
}

/**
 * A §5.4, and *before any money moves*: the release for this `h` already exists, so answer from it.
 *
 * The route calls this before it settles, because settling is not idempotent. A retried POST gets a
 * fresh transaction id from the facilitator, the release row's `pay_tx` then disagrees with a
 * payment the runner never meant to make, and check 9 refused the runner's own successful release —
 * as `policy`, which revoked the project for the crime of retrying after a dropped response.
 *
 * The commitment must match the stored one byte for byte. `h` is public — it is the payment memo,
 * and the whole request is in the `released` message on the topic — so answering some *other* `C`
 * from a stored row would seal B to whatever ephemeral key the caller supplied. Byte equality means
 * the envelope can only ever open under the key the original run generated, which is why this path
 * can skip checks 1–6 without becoming a share-B oracle: a replayer gets ciphertext it cannot open,
 * and pays nothing for it.
 */
export async function replayRelease(
  deps: PipelineDeps,
  input: ReplayInput,
): Promise<ReleaseOutcome | null> {
  const row = deps.repos.releases.get(input.h);
  if (!row || row.commitment_json !== canonicalize(input.C)) return null;
  const project = deps.repos.projects.get(row.project_id);
  // Revocation is the stop button: once it is down, not even a retry of a release that already
  // happened is answered here. The normal path takes it and refuses as check 8, on the record.
  // A missing project goes the same way for the same reason — this line decides whether a secret
  // moves, so both cases are spelled out rather than folded into `?.revoked !== 0`.
  if (!project) return null;
  if (project.revoked !== 0) return null;

  return await idempotentSuccess(
    deps,
    { h: input.h, body: input.body, C: input.C, payTx: row.pay_tx, project, now: deps.clock() },
    row,
  );
}

type PureResult =
  | { ok: true; claims: OidcClaims; policy: Policy }
  | { ok: false; failure: CheckFail; claims: OidcClaims | null };

async function runPureChecks(deps: PipelineDeps, attempt: ReleaseAttempt): Promise<PureResult> {
  const c1 = await checkPayment(deps, attempt);
  if (!c1.ok) return { ok: false, failure: c1, claims: null };

  const c2 = await checkJwt(deps, attempt);
  if (!c2.ok) return { ok: false, failure: c2, claims: null };
  const claims = c2.value;

  const c3 = checkCommitment(deps, attempt, claims);
  if (!c3.ok) return { ok: false, failure: c3, claims };

  const c4 = await checkPolicy(deps, attempt, claims);
  if (!c4.ok) return { ok: false, failure: c4, claims };

  const c5 = await checkWorkflow(deps, attempt, claims);
  if (!c5.ok) return { ok: false, failure: c5, claims };

  const c6 = checkSecretGeneration(deps, attempt, c4.value.policy);
  if (!c6.ok) return { ok: false, failure: c6, claims };

  // Check 4's policy is carried out of here rather than dropped: check 7's budget is the *policy's*
  // number, and re-fetching it inside the transaction would be a network call under BEGIN IMMEDIATE.
  return { ok: true, claims, policy: c4.value.policy };
}

/**
 * D29's quieter half: a release notice. The refusal alarm is the one that wakes you; this one is
 * the receipt you glance at, at a lower priority, and it exists so the answer to "did I expect
 * this?" is on the lock screen — which secret, which environment, which workflow, which run — with
 * `h` to look the whole thing up on the topic if the answer is no.
 *
 * Off by config for an operator who does not want a buzz per deploy; on by default because a
 * release nobody notices is the failure mode the project is named after.
 */
function releaseAlarm(
  deps: PipelineDeps,
  attempt: ReleaseAttempt,
  claims: OidcClaims,
): ReleaseAlarm | null {
  if (!deps.config.KLAXON_ALARM_ON_RELEASE) return null;
  return {
    topic: attempt.project.ntfy_topic,
    secret: attempt.C.secret,
    environment: attempt.C.environment,
    repository: attempt.project.repository,
    workflowRef: claims.workflow_ref,
    runId: claims.run_id,
    runAttempt: claims.run_attempt,
    h: attempt.h,
    payTx: attempt.payTx,
    tinybars: deps.config.X402_PRICE_TINYBAR,
  };
}

function sealShareB(
  deps: PipelineDeps,
  project: ProjectRow,
  secret: string,
  gen: string,
  attempt: ReleaseAttempt,
): ReleaseOk["share_b"] {
  const b = deriveShareB(deps.config.WITNESS_MASTER, project.project_id, secret, gen);
  return eciesSeal(attempt.C.ephemeral_pub.enc, attempt.h, b);
}

/**
 * A §5.4: the runner retried after a dropped response. Re-derive B, re-seal it, hand back the
 * consensus coordinates already recorded — and publish nothing new. No release alarm either: the
 * phone already buzzed for this `h`, and a retry is not a second release.
 */
async function idempotentSuccess(
  deps: PipelineDeps,
  attempt: ReleaseAttempt,
  row: { hcs_seq: string | null; hcs_consensus: string | null; outbox_id: number | null },
): Promise<ReleaseOutcome> {
  let seq = row.hcs_seq;
  let consensus = row.hcs_consensus;
  if ((!seq || !consensus) && row.outbox_id !== null) {
    // The first attempt committed the release but never got the message out. Finish that job
    // rather than starting a new one — the payment still gets exactly one `released`.
    const published = await publishOutboxId(
      { hcs: deps.hcs, outbox: deps.repos.outbox, log: deps.log },
      row.outbox_id,
    );
    if (published) {
      seq = published.sequenceNumber;
      consensus = published.consensusTimestamp;
      deps.repos.releases.setConsensus(attempt.h, seq, consensus);
    }
  }
  if (!seq || !consensus) {
    return infraRefusal(attempt.h, fail("infra", 0, "consensus record could not be published"));
  }
  return {
    status: 200,
    alarm: null,
    body: {
      ok: true,
      h: attempt.h,
      share_b: sealShareB(deps, attempt.project, attempt.C.secret, attempt.C.gen, attempt),
      hcs: { sequence_number: seq, consensus_timestamp: consensus },
    },
  };
}

/**
 * Records the refusal, revokes when the class says so, publishes the `refused` message, and hands
 * the route an alarm to fire after it has replied.
 *
 * `infra` never lands here: it publishes nothing and revokes nothing (PROTOCOL §6).
 */
async function refuse(
  deps: PipelineDeps,
  attempt: ReleaseAttempt,
  claims: OidcClaims | null,
  failure: CheckFail,
): Promise<ReleaseOutcome> {
  if (failure.class === "infra") return infraRefusal(attempt.h, failure);

  const cls = failure.class;
  const at = deps.clock().toISOString();
  const envelope = refusedEnvelope({
    ts: at,
    projectId: attempt.project.project_id,
    h: attempt.h,
    C: attempt.C,
    jwt: attempt.body.jwt,
    sig: attempt.body.sig,
    payTx: attempt.payTx,
    class: cls,
    check: failure.check,
    reason: failure.reason,
  });

  // D16: check 7 is a rate limit, not an attack signal, so it never revokes by default.
  const shouldRevoke =
    cls === "policy" && (failure.check !== 7 || deps.config.KLAXON_REVOKE_ON_BUDGET);

  const written = immediateTransaction(deps.db, () => {
    const refusalId = deps.repos.refusals.insert({
      h: attempt.h,
      project_id: attempt.project.project_id,
      class: cls,
      check_id: failure.check,
      reason: failure.reason,
      commitment_json: JSON.stringify(attempt.C),
      jwt: attempt.body.jwt,
      pay_tx: attempt.payTx,
      created_at: at,
    });
    // Revoking is not idempotent — it advances `local_epoch`, and check 8 only clears once the
    // chain epoch catches up. Re-revoking a project that is already revoked would let anyone
    // willing to keep paying push the epoch out from under the operator's `unrevoke`, so an
    // already-revoked project is left exactly where it is.
    const already = deps.repos.projects.get(attempt.project.project_id)?.revoked !== 0;
    let revoked = already;
    if (shouldRevoke && !already) {
      deps.repos.revocation.revoke(
        attempt.project.project_id,
        `${cls}/${failure.check}: ${failure.reason}`,
        attempt.h,
        at,
      );
      revoked = true;
    }
    const outboxId = deps.repos.outbox.enqueue(attempt.project.topic_id, "refused", envelope, at);
    return { refusalId, outboxId, revoked };
  });

  // Published *before* the 403 goes out, so the answer can say "your attempt is on the record,
  // HCS #N" — the same publish-then-answer ordering the success path uses (PROTOCOL §2).
  const published = await publishOutboxId(
    { hcs: deps.hcs, outbox: deps.repos.outbox, log: deps.log },
    written.outboxId,
  );
  if (published) {
    deps.repos.refusals.setConsensus(
      written.refusalId,
      published.sequenceNumber,
      published.consensusTimestamp,
    );
  }

  return {
    status: 403,
    body: {
      ok: false,
      h: attempt.h,
      class: cls,
      check: failure.check,
      reason: failure.reason,
      revoked: written.revoked,
      // Omitted rather than null when HCS could not be reached: the drain will publish it, but
      // this answer cannot honestly claim a sequence number it does not have.
      ...(published
        ? {
            hcs: {
              sequence_number: published.sequenceNumber,
              consensus_timestamp: published.consensusTimestamp,
            },
          }
        : {}),
    },
    alarm: {
      topic: attempt.project.ntfy_topic,
      secret: attempt.C.secret,
      repository: attempt.project.repository,
      runId: claims?.run_id ?? attempt.C.run_id,
      runAttempt: claims?.run_attempt ?? attempt.C.run_attempt,
      environment: attempt.C.environment,
      payTx: attempt.payTx,
      tinybars: deps.config.X402_PRICE_TINYBAR,
      class: cls,
      check: failure.check,
      reason: failure.reason,
      revoked: written.revoked,
    },
  };
}

/**
 * Check 0: there is no project, so there is no topic to publish to and no policy to apply. The
 * answer carries no `hcs` because nothing was recorded, and `revoked: false` because there was
 * nothing to revoke.
 */
function refusalWithoutTopic(h: string, failure: CheckFail): ReleaseOutcome {
  return {
    status: 403,
    alarm: null,
    body: {
      ok: false,
      h,
      class: failure.class,
      check: failure.check,
      reason: failure.reason,
      revoked: false,
    },
  };
}

function infraRefusal(h: string, failure: CheckFail): ReleaseOutcome {
  return {
    status: 503,
    alarm: null,
    body: { ok: false, h, class: "infra", check: failure.check, reason: failure.reason },
  };
}
