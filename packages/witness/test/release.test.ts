import { readFileSync } from "node:fs";
import {
  assertNotLeaked,
  CommitmentSchema,
  clearSecretRegistry,
  commitmentHash,
  NO_ENVIRONMENT,
  type Policy,
  PolicySchema,
  registerSecretMaterial,
  sha256,
} from "@klaxon/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AtomicRefusal, budgetFor, runAtomicChecks } from "../src/checks/c789-atomic.js";
import type { CheckFail, ReleaseAttempt } from "../src/checks/types.js";
import { immediateTransaction } from "../src/db/index.js";
import { deriveShareB } from "../src/shares/derive.js";
import {
  CLEAN_WORKFLOW,
  COMMIT_SHA,
  ENVIRONMENT,
  REPOSITORY,
  REPOSITORY_ID,
  SECRET,
  WORKFLOW_PATH,
  WORKFLOW_WITH_INSTALL_STEP,
  WORKFLOW_WITH_UNPINNED_USES,
  WORKFLOW_WITHOUT_ENVIRONMENT,
} from "./helpers/fixtures.js";
import {
  createHarness,
  type Harness,
  NTFY_TOPIC,
  PAY_ACCOUNT,
  PROJECT_ID,
  type ReleaseResult,
} from "./helpers/harness.js";

interface PolicyLimits {
  maxReleases?: number;
  envMaxReleases?: number;
}

function policyDocument(limits: PolicyLimits): Policy {
  return PolicySchema.parse({
    klaxon: 1,
    project_id: PROJECT_ID,
    repository_id: REPOSITORY_ID,
    max_releases: limits.maxReleases ?? 50,
    environments: {
      [ENVIRONMENT]: {
        secrets: [SECRET],
        ...(limits.envMaxReleases === undefined ? {} : { max_releases: limits.envMaxReleases }),
      },
    },
    workflow_rules: { forbid_install_steps: true, require_pinned_uses: true },
  });
}

/**
 * Serve a policy at `COMMIT_SHA` and anchor its hash, so check 4 accepts it and check 7 reads its
 * budget. The bytes are what is hashed (A §4.3), so the document is written once and used twice.
 */
function anchorPolicy(h: Harness, limits: PolicyLimits): void {
  const bytes = Buffer.from(`${JSON.stringify(policyDocument(limits), null, 2)}\n`, "utf8");
  h.source.put(REPOSITORY, COMMIT_SHA, "klaxon.policy.json", bytes);
  h.repos.projects.setPolicyAnchor(PROJECT_ID, sha256(bytes).toString("hex"), 1);
}

/** Checks 8/9/7 run inside a write transaction, so a test that wants one drives them directly. */
function atomicFailure(h: Harness, attempt: ReleaseAttempt, policy: Policy | null): CheckFail {
  try {
    immediateTransaction(h.db, () =>
      runAtomicChecks(h.ctx, { attempt, releasedEnvelope: {}, policy }),
    );
  } catch (err) {
    if (err instanceof AtomicRefusal) return err.failure;
    throw err;
  }
  throw new Error("expected the atomic block to refuse");
}

function attemptFor(h: Harness, result: ReleaseResult, payTx: string): ReleaseAttempt {
  const project = h.repos.projects.get(PROJECT_ID);
  if (!project) throw new Error("the fixture project is not registered");
  return {
    h: result.h,
    body: { C: result.C, jwt: "jwt", sig: "sig" },
    C: result.C,
    payTx,
    project,
    now: h.now(),
  };
}

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

  it("refuses an unlintable run step as auth/5 without revoking the project", async () => {
    // `${{ }}` inside a `run:` cannot be matched by a literal install-pattern regex, so the lint
    // refuses rather than guessing. But it is ordinary in honest workflows, and revoking costs a
    // Ledger and an on-chain transaction to undo — so a shape the witness cannot read must not
    // brick CI the way an actual install step does.
    h.source.put(
      REPOSITORY,
      COMMIT_SHA,
      WORKFLOW_PATH,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression is the point of this fixture
      CLEAN_WORKFLOW.replace(
        "- run: ./scripts/deploy.sh",
        "- run: ./deploy.sh ${{ inputs.target }}",
      ),
    );

    const result = await h.release();

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, class: "auth", check: 5, revoked: false });
    expect(revoked()).toBe(false);
    expect(h.hcs.ofType("refused")).toHaveLength(1);
  });

  it("refuses a workflow whose steps are not a list as auth/5 without revoking", async () => {
    // A job we cannot walk is a job we cannot vouch for, so it is refused — but a broken YAML
    // shape is the operator's own mistake, not an attempt on the secret, so the project lives.
    h.source.put(
      REPOSITORY,
      COMMIT_SHA,
      WORKFLOW_PATH,
      `name: deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps: not-a-list
`,
    );

    const result = await h.release();

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, class: "auth", check: 5, revoked: false });
    expect(revoked()).toBe(false);
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

  it.each(["pull_request", "pull_request_target"])(
    "refuses auth/5 for a %s event and does not revoke",
    async (event_name) => {
      // Any same-repo PR that runs the action lands here. As `policy` it revoked the project on an
      // ordinary pull request — recoverable only with the physical Ledger. `pull_request_target` is
      // the more dangerous of the two (base-repo context, real sha) and was not refused at all.
      const result = await h.release({ claims: { event_name } });

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ ok: false, class: "auth", check: 5, revoked: false });
      expect(result.body.reason).toBe(`release from a ${event_name} event is refused`);
      expect(revoked()).toBe(false);
      expect(h.hcs.ofType("refused")).toHaveLength(1);
    },
  );

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

  it("answers a replay of the published record from the record, charging nothing", async () => {
    const first = await h.release();
    expect(first.status).toBe(200);

    // The `released` message carries C, jwt and sig in full, so anyone reading the topic can
    // rebuild this exact request. It used to be answered with policy/9 *and a revoke* — pay a
    // fraction of a cent, brick someone's project. Now it is answered from the release row: the
    // envelope is sealed to the original run's ephemeral key, so a replayer gets ciphertext it
    // cannot open, and no second payment is taken for it.
    const replay = await h.release({ reuse: { C: first.C, ek: first.ek } });

    expect(replay.h).toBe(first.h);
    expect(replay.status).toBe(200);
    expect(revoked()).toBe(false);
    expect(h.hcs.ofType("released")).toHaveLength(1);
    expect(h.hcs.ofType("refused")).toHaveLength(0);
    expect(h.payment.settlements.size).toBe(1);
  });

  it("is idempotent for a retried POST, without settling a second payment", async () => {
    const first = await h.release();
    expect(first.status).toBe(200);

    const retry = await h.release({ reuse: { C: first.C, ek: first.ek } });

    expect(retry.h).toBe(first.h);
    expect(retry.status).toBe(200);
    // The facilitator hands back a *new* transaction id every time it settles, so the only way
    // `pay_tx` still matches is that the retry never reached the facilitator at all (A §5.4).
    expect(retry.payTx).toBe(first.payTx);
    expect(h.payment.settlements.size).toBe(1);
    // That payment already has exactly one `released`; it must not get a second (A §5.4).
    expect(h.hcs.messages).toHaveLength(1);
    expect(retry.body.hcs).toEqual(first.body.hcs);
    const expected = deriveShareB(h.config.WITNESS_MASTER, PROJECT_ID, SECRET, "1");
    expect(h.openShareB(retry).equals(expected)).toBe(true);
  });

  it("answers a retry that arrives with no payment header at all", async () => {
    // The runner already paid for this `h`; a dropped response is not a reason to charge twice.
    const first = await h.release();
    const retry = await h.app.inject({
      method: "POST",
      url: `/release/${first.h}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ C: first.C, jwt: "ignored", sig: "ignored" }),
    });

    expect(retry.statusCode).toBe(200);
    expect(h.payment.settlements.size).toBe(1);
    expect(h.hcs.messages).toHaveLength(1);
    // The runner learns `pay_tx` only from this header, and the action refuses a 200 without one.
    expect(retry.headers["payment-response"]).toBeTruthy();
  });

  it("does not answer a retry for a different commitment under the same h", async () => {
    // Byte equality with the stored commitment is what stops the replay path being a share-B
    // oracle: `h` is public, so a caller must not be able to have B re-sealed to *its* key.
    const first = await h.release();
    const forged = { ...first.C, ephemeral_pub: (await h.release({ runId: "9" })).C.ephemeral_pub };
    const response = await h.app.inject({
      method: "POST",
      url: `/release/${first.h}`,
      headers: { "content-type": "application/json", "payment-signature": "valid" },
      payload: JSON.stringify({ C: forged, jwt: "forged", sig: "forged" }),
    });

    // Refused as `auth`, and by the ordinary pipeline — the token is checked, the commitment is
    // checked, and no `share_b` comes back. The replay path declined to answer, which is the point.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ ok: false, class: "auth" });
    expect(response.json()).not.toHaveProperty("share_b");
  });

  it("refuses policy/7 against the policy's limit, not the projects column", async () => {
    // The column is seeded from KLAXON_MAX_RELEASES_DEFAULT and is a local ceiling; the number
    // `verify` enforces is the policy's. Reading the column here made the witness grant releases
    // the verifier then reported as MAX_RELEASES_EXCEEDED.
    const limited = await createHarness({ KLAXON_MAX_RELEASES_DEFAULT: "1" });
    limited.registerProject();
    limited.addShare();
    anchorPolicy(limited, { maxReleases: 2 });
    try {
      expect((await limited.release({ runId: "1" })).status).toBe(200);
      expect((await limited.release({ runId: "2" })).status).toBe(200);
      const third = await limited.release({ runId: "3" });

      expect(third.status).toBe(403);
      expect(third.body).toMatchObject({ ok: false, class: "policy", check: 7 });
      expect(third.body.reason).toContain("(2 allowed)");
      expect(limited.repos.projects.get(PROJECT_ID)?.revoked).toBe(0); // D16: never revokes
      expect(limited.hcs.ofType("released")).toHaveLength(2);
      expect(limited.hcs.ofType("refused")).toHaveLength(1);
    } finally {
      await limited.close();
    }
  });

  it("prefers the policy's per-environment limit over its default", async () => {
    // `verify`'s resolution order, matched exactly (verify/src/policy.ts `maxReleasesFor`).
    anchorPolicy(h, { maxReleases: 50, envMaxReleases: 1 });

    expect((await h.release({ runId: "1" })).status).toBe(200);
    const second = await h.release({ runId: "2" });

    expect(second.status).toBe(403);
    expect(second.body).toMatchObject({ ok: false, class: "policy", check: 7 });
    expect(second.body.reason).toContain("(1 allowed)");
    expect(revoked()).toBe(false);
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

  it("refuses while the Sepolia watcher is stale, and takes no money doing it", async () => {
    // The witness applies policy it learned by following Sepolia, so a stale cursor means the
    // revocation flag, the policy hash and the generation may all be out of date — a project the
    // owner revoked minutes ago would still be served. /health already goes red on this, but health
    // is advice: the deployed reverse proxy does not act on it, so the release path enforces it.
    // Checked before settlement, because charging for a request the witness already knows it cannot
    // answer is indefensible.
    h.registry.lag = 3_600;
    const result = await h.release();

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, class: "infra" });
    expect(h.payment.settlements.size).toBe(0);
    expect(revoked()).toBe(false);
    expect(h.hcs.messages).toHaveLength(0);
  });

  it("serves normally once the watcher has caught up", async () => {
    h.registry.lag = 0;
    const result = await h.release();
    expect(result.status).toBe(200);
  });

  it("refuses a stranger's payment WITHOUT revoking — the unauthenticated revocation hole", async () => {
    // `payerOf()` computed the debited account and nothing compared it to anything, so any funded
    // Hedera account could buy this project's release: `h` is public, and the memo is the only
    // thing tying a transfer to a commitment. Hence the comparison.
    //
    // But classifying the mismatch as `policy` opened something worse than it closed. Check 1 runs
    // before the OIDC token is parsed and `project_id` is published in the witness manifest, so a
    // policy-class failure here handed any stranger a remote kill switch on any registered project:
    // read the id, pay from your own account, POST `{"jwt":"x","sig":"x"}`, and the operator's
    // deploys are frozen until someone taps a physical Ledger. No GitHub identity anywhere in that
    // sequence. `revoked` staying false is the entire point of this test.
    h.payment.payer = "0.0.9999999";
    const result = await h.release();

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, class: "auth", check: 1, revoked: false });
    expect(result.body.reason).toContain(PAY_ACCOUNT);
    expect(revoked()).toBe(false);
  });

  it("leaves no revoking check reachable before the OIDC token is verified", async () => {
    // The structural guarantee behind the test above: every check that can revoke sits after
    // `checkJwt`, which binds the token's repository_id to the project. So reaching a revocation at
    // all requires running a workflow in the victim's own repository. If a future check revokes
    // before check 2, this fails and the kill switch is back.
    const src = readFileSync(new URL("../src/checks/c1-payment.ts", import.meta.url), "utf8");
    expect(src).not.toContain('fail("policy"');
  });

  it("releases when the debit is the registered payer", async () => {
    h.payment.payer = PAY_ACCOUNT;
    expect((await h.release()).status).toBe(200);
  });

  it("skips the payer binding for a project that registered no pay_account", async () => {
    // Older projects have nothing to bind to. Refusing them would be a protocol change wearing a
    // security fix's clothes, so the check is skipped — deliberately, and only for them.
    h.db.exec(`UPDATE projects SET pay_account = NULL WHERE project_id = '${PROJECT_ID}'`);
    h.payment.payer = "0.0.9999999";

    expect((await h.release()).status).toBe(200);
    expect(revoked()).toBe(false);
  });

  it("refuses auth/1 for a dust payment carrying a valid memo", async () => {
    // The memo is right, the transaction succeeded, and one tinybar reached the witness. Without
    // the floor, that is a release attempt nobody paid for.
    h.payment.credited = "1";
    const result = await h.release();

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, class: "auth", check: 1, revoked: false });
    expect(result.body.reason).toContain(h.config.X402_PRICE_TINYBAR);
    expect(revoked()).toBe(false);
  });

  it("releases when the credit exactly meets the advertised price", async () => {
    h.payment.credited = h.config.X402_PRICE_TINYBAR;
    expect((await h.release()).status).toBe(200);
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

  it("classes a second payment for the same commitment as auth/9, which never revokes", async () => {
    const first = await h.release();

    // Two POSTs for one release that crossed on the wire: both settled before either committed.
    // Nobody is lying — the runner paid twice for its own release — so the loser is told to try
    // again. As `policy` it revoked the project for a duplicated request.
    const failure = atomicFailure(h, attemptFor(h, first, "0.0.4821@1700000000.999"), null);

    expect(failure).toMatchObject({ class: "auth", check: 9 });
  });

  it("keeps policy/9 for a payment spent against a different commitment", async () => {
    const first = await h.release();
    if (!first.payTx) throw new Error("the first release settled no payment");
    const other = CommitmentSchema.parse({ ...first.C, run_id: "77" });
    const attempt = attemptFor(h, first, first.payTx);

    const failure = atomicFailure(
      h,
      { ...attempt, h: commitmentHash(other), C: other },
      policyDocument({}),
    );

    expect(failure).toMatchObject({ class: "policy", check: 9 });
  });

  it("sends a release notice on a success, carrying what the phone needs", async () => {
    const result = await h.release();

    expect(h.alarm.fired).toHaveLength(0);
    expect(h.alarm.notices).toHaveLength(1);
    expect(h.alarm.notices[0]).toMatchObject({
      topic: NTFY_TOPIC,
      secret: SECRET,
      environment: ENVIRONMENT,
      repository: REPOSITORY,
      workflowRef: `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
      runId: "4812345678",
      runAttempt: "1",
      h: result.h,
      payTx: result.payTx,
    });
  });

  it("does not send a second release notice for a retried POST", async () => {
    const first = await h.release();
    await h.release({ reuse: { C: first.C, ek: first.ek } });

    expect(h.alarm.notices).toHaveLength(1);
  });

  it("sends no release notice when KLAXON_ALARM_ON_RELEASE is off, and still refuses loudly", async () => {
    const quiet = await createHarness({ KLAXON_ALARM_ON_RELEASE: "false" });
    quiet.registerProject();
    quiet.addShare();
    try {
      expect((await quiet.release({ runId: "1" })).status).toBe(200);
      expect(quiet.alarm.notices).toHaveLength(0);

      // The flag is about the receipt, never about the alarm that matters.
      await quiet.release({ runId: "2", environment: NO_ENVIRONMENT, environmentClaim: null });
      expect(quiet.alarm.fired).toHaveLength(1);
      expect(quiet.alarm.fired[0]).toMatchObject({ class: "policy", check: 4, revoked: true });
    } finally {
      await quiet.close();
    }
  });

  it("fires the ntfy refusal alarm for a refusal and never for a success", async () => {
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
      // The release notice names the secret; it must never carry the secret.
      assertNotLeaked(JSON.stringify(h.alarm.notices));
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

/** The number check 7 counts against, resolved the way `verify` resolves it (verify/policy.ts). */
describe("check 7's release budget", () => {
  it("prefers the policy's per-environment override, then its default", () => {
    expect(budgetFor(policyDocument({ maxReleases: 9 }), ENVIRONMENT, 1)).toBe(9);
    expect(budgetFor(policyDocument({ maxReleases: 9, envMaxReleases: 2 }), ENVIRONMENT, 1)).toBe(
      2,
    );
  });

  it("falls back to the projects column only when there is no policy at all", () => {
    expect(budgetFor(null, ENVIRONMENT, 7)).toBe(7);
    // An environment the policy does not name never reaches check 7 — check 4 refuses it first —
    // but the resolver still answers with the policy's number rather than the local column.
    expect(budgetFor(policyDocument({ maxReleases: 9 }), "staging", 7)).toBe(9);
  });
});
