import { NO_ENVIRONMENT } from "@klaxon/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitmentHash as verifyCommitmentHash } from "../../verify/src/canonical.js";
import type { JwksOptions } from "../../verify/src/jwks.js";
import type { VerifyReport } from "../../verify/src/report.js";
import { applyRegistryEvent } from "../src/adapters/registry-events.js";
import { startJwksSnapshot } from "../src/jobs/jwks-snapshot.js";
import { startOutboxDrain } from "../src/jobs/outbox-drain.js";
import { silentLogger } from "../src/log.js";
import { audit, rotatedAwayJwks, type UnrevokeLog } from "./differential/audit.js";
import {
  type Capture,
  type CapturedMessage,
  capture,
  onlyMessageOfType,
} from "./differential/capture.js";
import { emergencyRecovery } from "./differential/emergency.js";
import {
  chunkCount,
  type DroppedChunk,
  mirrorTxId,
  renderTopic,
  renderTransactions,
} from "./differential/mirror.js";
import { SECRET } from "./helpers/fixtures.js";
import { createHarness, type Harness, PROJECT_ID } from "./helpers/harness.js";

/**
 * The witness and the verifier, driven against each other.
 *
 * `packages/witness` and `packages/verify` were written from PROTOCOL alone and share no code by
 * design (D5) — separate canonicalizers, separate hashes, separate JWT path, separate schemas.
 * That independence is only worth something if the two actually agree, so this test runs the real
 * release pipeline over the harness fakes, renders what it published into the exact mirror-node
 * JSON a third party would read, and hands that to the real `verify`. Nothing crosses between
 * them but bytes: the only imports from `../../verify/src` are the verifier's public surface.
 *
 * A disagreement here is a finding about one of the two implementations, never a reason to relax
 * an assertion.
 */

/** The harness's frozen clock. Payments settle one second before it (`settlementAgeS`). */
const T0 = new Date("2026-09-10T12:00:00.000Z");
const GRACE_SECONDS = 30;

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

interface AuditOverrides {
  now: Date;
  messages?: readonly CapturedMessage[];
  graceSeconds?: number;
  jwks?: JwksOptions;
  dropChunk?: DroppedChunk;
  unrevokes?: readonly UnrevokeLog[];
  paginate?: boolean;
}

/** Render a capture into mirror-node shapes and run the verifier over it. */
async function auditRun(h: Harness, cap: Capture, o: AuditOverrides): Promise<VerifyReport> {
  return audit({
    harness: h,
    messages: renderTopic(o.messages ?? cap.messages, {
      // The topic's submit key is the witness's own Hedera operator (PROTOCOL §7).
      payerAccount: h.config.witnessAccount,
      ...(o.dropChunk === undefined ? {} : { dropChunk: o.dropChunk }),
    }),
    transactions: renderTransactions(cap.payments, {
      witnessAccount: h.config.witnessAccount,
    }),
    now: o.now,
    graceSeconds: o.graceSeconds ?? GRACE_SECONDS,
    ...(o.jwks === undefined ? {} : { jwks: o.jwks }),
    ...(o.unrevokes === undefined ? {} : { unrevokes: o.unrevokes }),
    ...(o.paginate === undefined ? {} : { paginate: o.paginate }),
  });
}

describe("witness ↔ verify differential", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
    h.registerProject();
    h.addShare();
    h.setNow(T0);
  });

  afterEach(async () => {
    await h.close();
  });

  const post = async (path: string, body: unknown) =>
    h.app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/json", ...h.memberHeaders("POST", path, body) },
      payload: JSON.stringify(body),
    });

  describe("1 · a clean release", () => {
    it("re-derives the same h, pairs it, and finds nothing to report", async () => {
      const result = await h.release();
      expect(result.status).toBe(200);

      const cap = capture(h);
      const report = await auditRun(h, cap, { now: at(60) });

      expect(report.counts).toMatchObject({
        payments_found: 1,
        released: 1,
        refused: 0,
        emergency: 0,
        withheld: 0,
        pending: 0,
        double_releases: 0,
        incomplete_messages: 0,
        orphan_messages: 0,
      });
      expect(report.findings).toEqual([]);
      expect(report.violations).toBe(0);

      const attempt = report.attempts[0];
      expect(attempt?.type).toBe("released");
      expect(attempt?.h).toBe(result.h);
      expect(attempt?.hRecomputed).toBe(true);
      expect(attempt?.sigValid).toBe(true);
      expect(attempt?.audBinds).toBe(true);
      expect(attempt?.claimsMatch).toBe(true);
      expect(attempt?.jwt).toMatchObject({ ok: true, source: "live" });
      expect(attempt?.policy.state).toBe("matched");
      expect(attempt?.envSecret.state).toBe("ok");
      expect(attempt?.secret).toBe(SECRET);

      // Every row was actually exercised, not skipped as inapplicable.
      expect(report.tallies.jwts_valid).toEqual({ passed: 1, total: 1 });
      expect(report.tallies.aud_binds).toEqual({ passed: 1, total: 1 });
      expect(report.tallies.h_recomputed).toEqual({ passed: 1, total: 1 });
      expect(report.tallies.policy_matched).toEqual({ passed: 1, total: 1 });
      expect(report.tallies.env_secret).toEqual({ passed: 1, total: 1 });
    });

    it("needs chunking for an ordinary released, not only for a padded one", async () => {
      await h.release();
      // ~2 KB: a commitment plus a GitHub OIDC token does not fit in one 1024-byte chunk, so the
      // chunked path in PROTOCOL §7 is the normal path, not an edge case.
      expect(chunkCount(onlyMessageOfType(capture(h), "released"))).toBeGreaterThan(1);
    });

    it("computes h with its own canonicalizer over the C the witness published", async () => {
      const result = await h.release();
      const cap = capture(h);
      const published = onlyMessageOfType(cap, "released");

      // Two independent RFC 8785 implementations, one hash. This is the byte the whole protocol
      // hangs on: it is the OIDC `aud` suffix, the payment memo and the `/release/:h` path.
      expect(verifyCommitmentHash(published.message.C)).toBe(result.h);
      expect(published.message.h).toBe(result.h);
      expect(cap.payments[0]?.h).toBe(result.h);
    });

    it("reconciles the witness's SDK transaction id with the mirror node's dashed form", async () => {
      await h.release();
      const cap = capture(h);
      const published = onlyMessageOfType(cap, "released");

      // The witness records whatever x402 settlement handed it; the mirror node answers dashed
      // with nine-digit nanoseconds (PROTOCOL §5). `verify` has to pair across that difference.
      expect(String(published.message.pay_tx)).toContain("@");
      expect(mirrorTxId(String(published.message.pay_tx))).toMatch(/^\d+\.\d+\.\d+-\d+-\d{9}$/);

      const report = await auditRun(h, cap, { now: at(60) });
      expect(report.counts.released).toBe(1);
      expect(report.counts.orphan_messages).toBe(0);
      expect(report.attempts[0]?.payTx).toBe(String(published.message.pay_tx));
    });

    it("validates the same token against the witness's own published JWKS snapshot", async () => {
      // B §5.6: the snapshot has to reach consensus before the payment it will later cover.
      const snapshot = startJwksSnapshot(h.ctx);
      expect(await snapshot.runOnce()).toBe(true);
      snapshot.stop();

      h.setNow(at(120));
      const result = await h.release();
      expect(result.status).toBe(200);

      const cap = capture(h);
      // GitHub has rotated the key away, so only the snapshot can answer.
      const report = await auditRun(h, cap, {
        now: at(180),
        jwks: { remote: rotatedAwayJwks },
      });

      expect(report.violations).toBe(0);
      expect(report.tallies.jwts_valid).toEqual({ passed: 1, total: 1 });
      expect(report.tallies.jwts_via_snapshot).toBe(1);
      expect(report.attempts[0]?.jwt).toMatchObject({ ok: true, source: "snapshot" });
    });

    it("survives a paginated topic read", async () => {
      await h.release();
      const cap = capture(h);
      const report = await auditRun(h, cap, { now: at(60), paginate: true });
      expect(report.counts.released).toBe(1);
      expect(report.violations).toBe(0);
    });
  });

  describe("2 · the honest worm", () => {
    it("refuses policy/4, revokes, and the auditor agrees the refusal was right", async () => {
      const result = await h.release({ environment: NO_ENVIRONMENT, environmentClaim: null });

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ class: "policy", check: 4, revoked: true });
      expect(h.repos.projects.get(PROJECT_ID)?.revoked).toBe(1);

      const cap = capture(h);
      const report = await auditRun(h, cap, { now: at(60) });

      expect(report.counts).toMatchObject({
        payments_found: 1,
        released: 0,
        refused: 1,
        withheld: 0,
        orphan_messages: 0,
      });
      // A refusal is the witness doing its job: it is reported, never counted against it.
      expect(report.violations).toBe(0);

      const attempt = report.attempts[0];
      expect(attempt?.type).toBe("refused");
      expect(attempt?.refusal).toEqual({
        class: "policy",
        check: 4,
        reason: "requested by a job with no environment",
      });
      // The commitment was truthful — the job really had no environment — so the claim
      // cross-check passes and only the policy row fails.
      expect(attempt?.environment).toBe(NO_ENVIRONMENT);
      expect(attempt?.claimsMatch).toBe(true);
      expect(attempt?.hRecomputed).toBe(true);
      expect(attempt?.sigValid).toBe(true);
      expect(attempt?.jwt.ok).toBe(true);
      expect(attempt?.policy.state).toBe("matched");
      expect(attempt?.envSecret.state).toBe("fail");

      expect(report.findings.map((f) => f.code)).toEqual(["ENV_NOT_IN_POLICY"]);
      expect(report.findings[0]?.severity).toBe("unverified");
      expect(report.findings[0]?.detail).toContain(NO_ENVIRONMENT);
    });
  });

  describe("3 · a withheld release", () => {
    it("says nothing inside the grace window and WITNESS WITHHELD after it", async () => {
      await h.release();
      const cap = capture(h);
      const silent = cap.messages.filter((m) => m.message.type !== "released");
      expect(silent).toHaveLength(0);

      // The payment settled one second before T0, so the 30s window closes at T0 + 29s.
      const early = await auditRun(h, cap, { now: at(28), messages: silent });
      expect(early.counts.pending).toBe(1);
      expect(early.counts.withheld).toBe(0);
      expect(early.findings).toEqual([]);
      expect(early.violations).toBe(0);

      const late = await auditRun(h, cap, { now: at(30), messages: silent });
      expect(late.counts.pending).toBe(0);
      expect(late.counts.withheld).toBe(1);
      expect(late.findings.map((f) => f.code)).toEqual(["WITNESS_WITHHELD"]);
      expect(late.findings[0]?.severity).toBe("violation");
      expect(late.violations).toBe(1);
    });
  });

  describe("4 · an idempotent retry", () => {
    it("publishes one message for one payment, and the auditor sees no double release", async () => {
      const first = await h.release();
      const retry = await h.release({ reuse: { C: first.C, ek: first.ek } });

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(retry.h).toBe(first.h);
      expect(retry.payTx).toBe(first.payTx);
      expect(h.hcs.messages).toHaveLength(1);

      const cap = capture(h);
      expect(cap.payments).toHaveLength(1);

      const report = await auditRun(h, cap, { now: at(60) });
      expect(report.counts.payments_found).toBe(1);
      expect(report.counts.released).toBe(1);
      expect(report.counts.double_releases).toBe(0);
      expect(report.findings.filter((f) => f.code === "DOUBLE_RELEASE")).toEqual([]);
      expect(report.violations).toBe(0);
    });
  });

  describe("5 · chunked messages", () => {
    /** A padded claim pushes the token, and so the envelope, well past one chunk. */
    const longJwt = { klaxon_padding: "x".repeat(1500) };

    it("reassembles a multi-chunk released and dates it at the last chunk", async () => {
      const result = await h.release({ claims: longJwt });
      expect(result.status).toBe(200);

      const cap = capture(h);
      const published = onlyMessageOfType(cap, "released");
      expect(chunkCount(published)).toBeGreaterThan(3);

      const report = await auditRun(h, cap, { now: at(60) });
      expect(report.counts.released).toBe(1);
      expect(report.counts.incomplete_messages).toBe(0);
      expect(report.violations).toBe(0);
      expect(report.attempts[0]?.hRecomputed).toBe(true);

      // PROTOCOL §7: the whole message reached consensus when its last chunk did, which is the
      // coordinate the witness handed back in `ReleaseOk.hcs`.
      expect(report.attempts[0]?.messageConsensus).toBe(published.consensusTimestamp);
      expect(result.body.hcs).toMatchObject({
        consensus_timestamp: published.consensusTimestamp,
      });
    });

    it("reports a missing chunk as MESSAGE_INCOMPLETE rather than a withheld release", async () => {
      await h.release({ claims: longJwt });
      const cap = capture(h);

      // A mid-ingestion read: the chunk was submitted, the mirror node has not served it yet.
      const report = await auditRun(h, cap, {
        now: at(20),
        dropChunk: { messageIndex: 0, number: 2 },
      });

      expect(report.counts.incomplete_messages).toBe(1);
      expect(report.counts.withheld).toBe(0);
      expect(report.counts.pending).toBe(1);
      expect(report.findings.map((f) => f.code)).toEqual(["MESSAGE_INCOMPLETE"]);
      expect(report.findings[0]?.severity).toBe("unverified");
      expect(report.violations).toBe(0);
    });

    it("also calls the payment withheld once the grace window has closed", async () => {
      // Recorded rather than asserted as desirable: `reassemble` is written so an incomplete group
      // does not look like a withheld release, but `pairPayments` cannot see the incomplete group,
      // so past the grace window both findings are raised for the same missing message.
      await h.release({ claims: longJwt });
      const cap = capture(h);

      const report = await auditRun(h, cap, {
        now: at(60),
        dropChunk: { messageIndex: 0, number: 2 },
      });

      expect([...report.findings.map((f) => f.code)].sort()).toEqual([
        "MESSAGE_INCOMPLETE",
        "WITNESS_WITHHELD",
      ]);
      expect(report.violations).toBe(1);
    });
  });

  describe("6 · the rest of the lifecycle on the same topic", () => {
    it("pairs through rotate, revoke, unrevoke and an operator emergency", async () => {
      const released = await h.release();
      expect(released.status).toBe(200);

      h.setNow(at(10));
      const rotate = await post("/rotate", { project_id: PROJECT_ID, secret: SECRET, gen: "2" });
      expect(rotate.statusCode).toBe(200);

      h.setNow(at(20));
      const revoke = await post("/revoke", { project_id: PROJECT_ID, reason: "stolen laptop" });
      expect(revoke.statusCode).toBe(200);

      h.setNow(at(30));
      applyRegistryEvent(
        { repos: h.repos, clock: h.now, log: silentLogger },
        {
          eventName: "Unrevoked",
          args: { p: `0x${PROJECT_ID}`, epoch: 1n },
          transactionHash: `0x${"1".repeat(64)}`,
        },
      );
      const drain = startOutboxDrain(h.ctx);
      expect(await drain.runOnce()).toBe(1);
      drain.stop();

      const cap = capture(h);
      expect(cap.messages.map((m) => m.message.type)).toEqual([
        "released",
        "rotate",
        "revoke",
        "unrevoke",
      ]);

      // PROTOCOL §7's break-glass, published by the laptop key on the same topic and paid for
      // with its own commitment hash as the memo.
      const seconds = Math.floor(T0.getTime() / 1000);
      const rescue = emergencyRecovery({
        projectId: PROJECT_ID,
        topicId: cap.messages[0]?.topicId ?? "",
        secret: SECRET,
        gen: "2",
        ts: at(40).toISOString(),
        payTx: `0.0.7777@${seconds + 39}.100000000`,
        paymentConsensus: `${seconds + 40}.000000000`,
        messageConsensus: `${seconds + 41}.000000000`,
        sequenceNumber: "99",
        amountTinybar: h.config.X402_PRICE_TINYBAR,
      });
      cap.messages.push(rescue.message);
      cap.payments.push(rescue.payment);

      const report = await auditRun(h, cap, {
        now: at(120),
        unrevokes: [{ epoch: 1n, seconds: BigInt(seconds + 25) }],
      });

      expect(report.counts).toMatchObject({
        payments_found: 2,
        released: 1,
        refused: 0,
        emergency: 1,
        withheld: 0,
        pending: 0,
        double_releases: 0,
        incomplete_messages: 0,
        orphan_messages: 0,
      });
      expect(report.findings).toEqual([]);
      expect(report.violations).toBe(0);

      // The lifecycle messages are read and set aside; they never become attempts or orphans.
      expect(report.attempts.map((a) => a.type).sort()).toEqual(["emergency", "released"]);

      const recovered = report.attempts.find((a) => a.type === "emergency");
      expect(recovered?.h).toBe(rescue.h);
      expect(recovered?.hRecomputed).toBe(true);
      expect(recovered?.secret).toBe(SECRET);
      expect(recovered?.gen).toBe("2");
      expect(recovered?.policy.state).toBe("n/a");
      expect(recovered?.jwt.ok).toBeNull();
    });
  });
});
