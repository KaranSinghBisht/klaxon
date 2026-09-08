import {
  assertNotLeaked,
  clearSecretRegistry,
  NO_ENVIRONMENT,
  registerSecretMaterial,
} from "@klaxon/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveShareB } from "../src/shares/derive.js";
import {
  COMMIT_SHA,
  REPOSITORY,
  SECRET,
  WORKFLOW_PATH,
  WORKFLOW_WITH_INSTALL_STEP,
  WORKFLOW_WITH_UNPINNED_USES,
  WORKFLOW_WITHOUT_ENVIRONMENT,
} from "./helpers/fixtures.js";
import { createHarness, type Harness, NTFY_TOPIC, PROJECT_ID } from "./helpers/harness.js";

/**
 * The nine checks, driven through the real HTTP surface. Every case asserts the exact
 * `{class, check}` pair, whether the project's `revoked` flag flipped, and how many HCS messages
 * were published — the three things `verify` will later re-derive from public data.
 */
describe("POST /release/:h", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
    h.registerProject();
    h.addShare();
  });

  afterEach(async () => {
    await h.close();
  });

  const revoked = (): boolean => h.repos.projects.get(PROJECT_ID)?.revoked !== 0;

  it("releases share B after the consensus record exists", async () => {
    const result = await h.release();

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.h).toBe(result.h);

    // Exactly one `released`, and B only moved after it reached consensus (A §5.3).
    expect(h.hcs.messages).toHaveLength(1);
    const message = h.hcs.messages[0];
    expect(message?.message.type).toBe("released");
    expect(message?.message.pay_tx).toBe(result.payTx);
    expect(result.body.hcs).toEqual({
      sequence_number: message?.sequenceNumber,
      consensus_timestamp: message?.consensusTimestamp,
    });

    // The envelope really does open to the derived share B, under the runner's ephemeral key.
    const expected = deriveShareB(h.config.WITNESS_MASTER, PROJECT_ID, SECRET, "1");
    expect(h.openShareB(result).equals(expected)).toBe(true);
    expect(revoked()).toBe(false);
  });

  it("refuses auth/3 when the job declared no environment but C claims production", async () => {
    // A §0.5, the attack the whole protocol turns on: `aud` still matches `h` perfectly. This is
    // the lie, as distinct from the honest "(none)" below.
    const result = await h.release({ environment: "production", environmentClaim: null });

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, class: "auth", check: 3, revoked: false });
    expect(revoked()).toBe(false); // auth never revokes
    expect(h.hcs.ofType("refused")).toHaveLength(1);
  });

  it('refuses auth/3 when C says "(none)" but the token names a real environment', async () => {
    const result = await h.release({
      environment: NO_ENVIRONMENT,
      environmentClaim: "production",
    });

    expect(result.body).toMatchObject({ ok: false, class: "auth", check: 3 });
    expect(revoked()).toBe(false);
  });

  it('refuses policy/4 and revokes for an honest "(none)" from a job with no environment', async () => {
    // The money shot. The worm's commitment is truthful — it really did run in a job with no
    // environment — so check 3 passes. "(none)" is not a policy environment, so check 4 refuses
    // it as `policy`, which is what revokes the project.
    const result = await h.release({ environment: NO_ENVIRONMENT, environmentClaim: null });

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({
      ok: false,
      class: "policy",
      check: 4,
      reason: "requested by a job with no environment",
      revoked: true,
    });
    expect(revoked()).toBe(true);
    expect(h.hcs.ofType("refused")).toHaveLength(1);
    expect(h.alarm.fired[0]).toMatchObject({ environment: NO_ENVIRONMENT, revoked: true });
  });

  it("refuses auth/3 when C.run_id disagrees with the token", async () => {
    const result = await h.release({ runId: "111", commitmentRunId: "222" });

    expect(result.body).toMatchObject({ ok: false, class: "auth", check: 3 });
    expect(revoked()).toBe(false);
  });

  it("refuses auth/2 for a token signed by a key GitHub does not advertise", async () => {
    const result = await h.release({ signWithForeignKey: true });

    expect(result.body).toMatchObject({ ok: false, class: "auth", check: 2 });
    expect(revoked()).toBe(false);
  });

  it("refuses policy/5 when the environment job runs an install step", async () => {
    h.source.put(REPOSITORY, COMMIT_SHA, WORKFLOW_PATH, WORKFLOW_WITH_INSTALL_STEP);
    const result = await h.release();

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, class: "policy", check: 5 });
    expect(revoked()).toBe(true); // policy revokes (D16 exempts only check 7)
    expect(h.hcs.ofType("refused")).toHaveLength(1);
  });

  it("puts the refusal on the record before answering, and says so in the 403", async () => {
    // PROTOCOL §2: an auth/policy refusal is published first, so the action can print
    // "refused … on the record: HCS #N · project revoked".
    h.source.put(REPOSITORY, COMMIT_SHA, WORKFLOW_PATH, WORKFLOW_WITH_INSTALL_STEP);
    const result = await h.release();

    const published = h.hcs.ofType("refused")[0];
    expect(result.body.hcs).toEqual({
      sequence_number: published?.sequenceNumber,
      consensus_timestamp: published?.consensusTimestamp,
    });
    expect(result.body.revoked).toBe(true);
    expect(result.body.revoked).toBe(revoked());
  });

  it("reports revoked: false on an auth refusal, which never revokes", async () => {
    const result = await h.release({ environment: "production", environmentClaim: null });

    expect(result.body.revoked).toBe(false);
    expect(result.body.revoked).toBe(revoked());
    expect(result.body.hcs).toEqual({
      sequence_number: h.hcs.ofType("refused")[0]?.sequenceNumber,
      consensus_timestamp: h.hcs.ofType("refused")[0]?.consensusTimestamp,
    });
  });

  it("omits hcs from a 503 and from a refusal it could not publish", async () => {
    h.payment.mirrorMode = "infra";
    const infra = await h.release({ runId: "1" });
    expect(infra.status).toBe(503);
    expect(infra.body.hcs).toBeUndefined();
    expect(infra.body.revoked).toBeUndefined();

    // An auth/policy refusal whose message could not be pushed must not claim a sequence number.
    h.payment.mirrorMode = "ok";
    h.hcs.failNext = true;
    const unpublished = await h.release({ runId: "2", gen: "2" });
    expect(unpublished.status).toBe(403);
    expect(unpublished.body.hcs).toBeUndefined();
    expect(unpublished.body.revoked).toBe(true);
  });

  it("refuses policy/5 for an unpinned uses:", async () => {
    h.source.put(REPOSITORY, COMMIT_SHA, WORKFLOW_PATH, WORKFLOW_WITH_UNPINNED_USES);
    const result = await h.release();

    expect(result.body).toMatchObject({ ok: false, class: "policy", check: 5 });
    expect(revoked()).toBe(true);
  });

  it("refuses policy/5 when no job declares the environment", async () => {
    h.source.put(REPOSITORY, COMMIT_SHA, WORKFLOW_PATH, WORKFLOW_WITHOUT_ENVIRONMENT);
    const result = await h.release();

    expect(result.body).toMatchObject({ ok: false, class: "policy", check: 5 });
  });

  it("refuses policy/5 for a pull_request event", async () => {
    const result = await h.release({ claims: { event_name: "pull_request" } });

    expect(result.body).toMatchObject({ ok: false, class: "policy", check: 5 });
  });

  it("refuses policy/5 for a reusable workflow outside the project", async () => {
    const result = await h.release({
      claims: { job_workflow_ref: `someone-else/actions/.github/workflows/x.yml@refs/heads/main` },
    });

    expect(result.body).toMatchObject({ ok: false, class: "policy", check: 5 });
  });

  it("refuses policy/6 when the secret is not in the policy", async () => {
    h.addShare("OTHER_SECRET", 1);
    const result = await h.release({ secret: "OTHER_SECRET" });

    expect(result.body).toMatchObject({ ok: false, class: "policy", check: 6 });
    expect(revoked()).toBe(true);
  });

  it("refuses policy/6 for a stale generation", async () => {
    const result = await h.release({ gen: "2" });

    expect(result.body).toMatchObject({ ok: false, class: "policy", check: 6 });
  });

  it("refuses policy/9 when h is replayed under a new payment", async () => {
    const first = await h.release();
    expect(first.status).toBe(200);

    // A different payment for the same commitment: a genuine replay, not a retry.
    h.payment.forget(first.h);
    const replay = await h.release({ reuse: { C: first.C, ek: first.ek } });

    expect(replay.h).toBe(first.h);
    expect(replay.status).toBe(403);
    expect(replay.body).toMatchObject({ ok: false, class: "policy", check: 9 });
    expect(revoked()).toBe(true);
    expect(h.hcs.ofType("released")).toHaveLength(1);
    expect(h.hcs.ofType("refused")).toHaveLength(1);
  });

  it("is idempotent for a retried POST carrying the same pay_tx", async () => {
    const first = await h.release();
    expect(first.status).toBe(200);

    const retry = await h.release({ reuse: { C: first.C, ek: first.ek } });

    expect(retry.h).toBe(first.h);
    expect(retry.status).toBe(200);
    expect(retry.payTx).toBe(first.payTx);
    // That payment already has exactly one `released`; it must not get a second (A §5.4).
    expect(h.hcs.messages).toHaveLength(1);
    expect(retry.body.hcs).toEqual(first.body.hcs);
    const expected = deriveShareB(h.config.WITNESS_MASTER, PROJECT_ID, SECRET, "1");
    expect(h.openShareB(retry).equals(expected)).toBe(true);
  });

  it("refuses policy/7 when the budget is exhausted, without revoking (D16)", async () => {
    const limited = await createHarness({ KLAXON_MAX_RELEASES_DEFAULT: "1" });
    limited.registerProject();
    limited.addShare();
    try {
      expect((await limited.release({ runId: "1" })).status).toBe(200);
      const second = await limited.release({ runId: "2" });

      expect(second.status).toBe(403);
      expect(second.body).toMatchObject({ ok: false, class: "policy", check: 7 });
      expect(limited.repos.projects.get(PROJECT_ID)?.revoked).toBe(0);
      expect(limited.hcs.ofType("released")).toHaveLength(1);
      expect(limited.hcs.ofType("refused")).toHaveLength(1);
    } finally {
      await limited.close();
    }
  });

  it("refuses policy/8 for a revoked project", async () => {
    h.repos.revocation.revoke(PROJECT_ID, "operator pulled the cord", null, h.now().toISOString());
    const result = await h.release();

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, class: "policy", check: 8 });
    expect(h.hcs.ofType("refused")).toHaveLength(1);
  });

  it("does not advance the epoch again on a project that is already revoked", async () => {
    // Otherwise anyone willing to keep paying could push local_epoch out from under the
    // operator's on-chain `unrevoke`, and the project could never be brought back.
    h.repos.revocation.revoke(PROJECT_ID, "first", null, h.now().toISOString());
    const epochBefore = h.repos.projects.get(PROJECT_ID)?.local_epoch;

    await h.release({ runId: "1" });
    await h.release({ runId: "2" });

    expect(h.repos.projects.get(PROJECT_ID)?.local_epoch).toBe(epochBefore);
    expect(h.hcs.ofType("refused")).toHaveLength(2); // both refusals are still recorded
  });

  it("refuses policy/8 while the local epoch is ahead of the chain", async () => {
    // Revoked, then cleared locally but not yet on Sepolia: still refuses until the epochs meet.
    h.repos.revocation.revoke(PROJECT_ID, "test", null, h.now().toISOString());
    h.db.exec(`UPDATE projects SET revoked = 0 WHERE project_id = '${PROJECT_ID}'`);
    const result = await h.release();

    expect(result.body).toMatchObject({ ok: false, class: "policy", check: 8 });
  });

  it("answers 503 with class infra and neither revokes nor publishes when the mirror is down", async () => {
    h.payment.mirrorMode = "infra";
    const result = await h.release();

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, class: "infra" });
    expect(revoked()).toBe(false);
    expect(h.hcs.messages).toHaveLength(0);
    expect(h.alarm.fired).toHaveLength(0);
  });

  it("answers 503 with class infra when GitHub cannot be reached", async () => {
    h.source.down = true;
    const result = await h.release();

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, class: "infra", check: 4 });
    expect(revoked()).toBe(false);
    expect(h.hcs.messages).toHaveLength(0);
  });

  it("refuses auth/1 for a stale payment", async () => {
    h.payment.settlementAgeS = h.config.KLAXON_PAYMENT_MAX_AGE_S + 60;
    const result = await h.release();

    expect(result.body).toMatchObject({ ok: false, class: "auth", check: 1 });
  });

  it("refuses auth/0 for an unregistered project without publishing anything", async () => {
    const empty = await createHarness();
    try {
      const result = await empty.release();
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ ok: false, class: "auth", check: 0 });
      expect(empty.hcs.messages).toHaveLength(0);
    } finally {
      await empty.close();
    }
  });

  it("fires the ntfy alarm for a refusal and never for a success", async () => {
    await h.release();
    expect(h.alarm.fired).toHaveLength(0);
    // The clean workflow at COMMIT_SHA is now cached, and a sha is immutable — a job can only
    // look different at a different commit (B §5.3).
    const dirty = "b".repeat(40);
    h.stageCommit(dirty, WORKFLOW_WITH_INSTALL_STEP);
    await h.release({
      runId: "999",
      claims: { sha: dirty, workflow_sha: dirty, job_workflow_sha: dirty },
    });

    expect(h.alarm.fired).toHaveLength(1);
    expect(h.alarm.fired[0]).toMatchObject({ class: "policy", check: 5, revoked: true });
    expect(h.alarm.fired[0]?.topic).toBe(NTFY_TOPIC);
  });

  it("caches the workflow at its immutable sha", async () => {
    await h.release();
    const cached = h.repos.workflowCache.get(REPOSITORY, COMMIT_SHA, WORKFLOW_PATH);
    expect(cached).toContain("environment: production");
  });

  it("never puts share B anywhere but the sealed envelope", async () => {
    // A §7.2's leak test, narrowed to what this package controls: B must not reach the consensus
    // log, the database, or a refusal body in any encoding.
    const b = deriveShareB(h.config.WITNESS_MASTER, PROJECT_ID, SECRET, "1");
    registerSecretMaterial(b);
    try {
      const ok = await h.release({ runId: "1" });
      const dirty = "c".repeat(40);
      h.stageCommit(dirty, WORKFLOW_WITH_INSTALL_STEP);
      const refused = await h.release({
        runId: "2",
        claims: { sha: dirty, workflow_sha: dirty, job_workflow_sha: dirty },
      });

      assertNotLeaked(JSON.stringify(h.hcs.messages));
      assertNotLeaked(JSON.stringify(refused.body));
      assertNotLeaked(JSON.stringify(h.repos.releases.get(ok.h)));
      assertNotLeaked(JSON.stringify(h.repos.refusals.listForH(refused.h)));
      assertNotLeaked(JSON.stringify(h.alarm.fired));
      // ...and the one place it is allowed to be, it really is.
      expect(h.openShareB(ok).equals(b)).toBe(true);
    } finally {
      clearSecretRegistry();
    }
  });

  it("answers 402 with the memo-bearing requirements when no payment is presented", async () => {
    const response = await h.app.inject({ method: "GET", url: `/release/${"a".repeat(64)}` });

    expect(response.statusCode).toBe(402);
    expect(response.headers["payment-required"]).toBeTruthy();
    const body = response.json() as { accepts: Array<{ extra: { memo: string } }> };
    expect(body.accepts[0]?.extra.memo).toBe("a".repeat(64));
  });

  it("rejects a malformed h without touching payment", async () => {
    const response = await h.app.inject({ method: "GET", url: "/release/not-a-hash" });
    expect(response.statusCode).toBe(400);
  });
});
