import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backoffMs, MAX_OUTBOX_ATTEMPTS, startOutboxDrain } from "../src/jobs/outbox-drain.js";
import { TOPIC_ID } from "./helpers/fixtures.js";
import { createHarness, type Harness, PROJECT_ID } from "./helpers/harness.js";

/**
 * D23 — the outbox is the difference between a demo that survives a restart and one that does not.
 * Without it, a crash between "decided to release" and "published" leaves a settled payment with
 * no message, and `verify` correctly reports `WITNESS WITHHELD` against an honest witness.
 */
describe("hcs outbox", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
    h.registerProject();
    h.addShare();
  });

  afterEach(async () => {
    await h.close();
  });

  it("does not release B when the consensus record cannot be published", async () => {
    h.hcs.failNext = true;
    const result = await h.release();

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, class: "infra" });
    expect(result.body.share_b).toBeUndefined();
    expect(h.hcs.messages).toHaveLength(0);

    // The decision and the intent to publish both survive, waiting for the drain.
    expect(h.repos.releases.get(result.h)?.hcs_seq).toBeNull();
    expect(h.repos.outbox.countByState("pending")).toBe(1);
  });

  it("drains the pending message afterwards and the retry then succeeds with no second message", async () => {
    h.hcs.failNext = true;
    const first = await h.release();
    expect(first.status).toBe(503);

    const drain = startOutboxDrain(h.ctx);
    try {
      expect(await drain.runOnce()).toBe(1);
    } finally {
      drain.stop();
    }
    expect(h.hcs.ofType("released")).toHaveLength(1);
    expect(h.repos.outbox.countByState("pending")).toBe(0);

    const retry = await h.release({ reuse: { C: first.C, ek: first.ek } });

    expect(retry.status).toBe(200);
    expect(retry.h).toBe(first.h);
    expect(h.hcs.messages).toHaveLength(1); // exactly one `released` per payment
    expect(retry.body.hcs).toEqual({
      sequence_number: h.hcs.messages[0]?.sequenceNumber,
      consensus_timestamp: h.hcs.messages[0]?.consensusTimestamp,
    });
    expect(h.repos.releases.get(first.h)?.hcs_seq).toBe(h.hcs.messages[0]?.sequenceNumber);
  });

  it("keeps a refusal's message pending when HCS is down, and still answers 403", async () => {
    h.hcs.failNext = true;
    const result = await h.release({ gen: "2" }); // policy/6

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ class: "policy", check: 6 });
    expect(h.repos.outbox.countByState("pending")).toBe(1);
    // The refusal is recorded and the project revoked regardless of whether the push landed.
    expect(h.repos.projects.get(PROJECT_ID)?.revoked).toBe(1);
    expect(h.repos.refusals.listForH(result.h)).toHaveLength(1);
  });
});

/**
 * The queue is the audit trail. One message that can never be delivered — a topic deleted under
 * the witness, a submit key rotated away — must not keep every later `released` and `refused` off
 * the ledger, because "every decision is on the record" is the whole claim.
 *
 * These drive the drain over rows enqueued directly, so they exercise queue behaviour rather than
 * the release path.
 */
describe("outbox drain, when one row cannot be delivered", () => {
  let h: Harness;

  /** A queued message of `kind`, indistinguishable to the drain from one a decision enqueued. */
  const enqueue = (kind: "released" | "refused"): number =>
    h.repos.outbox.enqueue(TOPIC_ID, kind, { type: kind }, h.now().toISOString());

  /** Move past any backoff the drain could have scheduled, including the capped one. */
  const skipBackoff = (): void => h.setNow(new Date(h.now().getTime() + 600_000));

  beforeEach(async () => {
    h = await createHarness();
    h.registerProject();
  });

  afterEach(async () => {
    await h.close();
  });

  it("publishes the messages queued behind it instead of stopping at it", async () => {
    const stuck = enqueue("released");
    const behind = enqueue("refused");

    const drain = startOutboxDrain(h.ctx);
    try {
      h.hcs.failNext = true; // only the first row of this pass is undeliverable
      expect(await drain.runOnce()).toBe(1);
    } finally {
      drain.stop();
    }

    expect(h.hcs.ofType("refused")).toHaveLength(1);
    expect(h.repos.outbox.get(behind)?.state).toBe("sent");
    // Still retryable, and its attempt is counted — at-least-once is not traded away for progress.
    expect(h.repos.outbox.get(stuck)?.state).toBe("pending");
    expect(h.repos.outbox.get(stuck)?.attempts).toBe(1);
  });

  it("waits out the backoff rather than retrying the same row on every tick", async () => {
    const id = enqueue("released");

    const drain = startOutboxDrain(h.ctx);
    try {
      h.hcs.failNext = true;
      await drain.runOnce();
      expect(h.repos.outbox.get(id)?.attempts).toBe(1);

      // Same instant: the row is inside its backoff window and must not be touched. If it were,
      // this pass would publish it — nothing is set to fail — and both assertions would move.
      expect(await drain.runOnce()).toBe(0);
      expect(h.repos.outbox.get(id)?.attempts).toBe(1);
      expect(h.hcs.messages).toHaveLength(0);

      h.setNow(new Date(h.now().getTime() + backoffMs(1) + 1));
      expect(await drain.runOnce()).toBe(1);
    } finally {
      drain.stop();
    }
    expect(h.repos.outbox.get(id)?.state).toBe("sent");
  });

  it("retires it to failed once the retry budget is spent, and says so", async () => {
    const id = enqueue("released");
    const behind = enqueue("refused");

    const drain = startOutboxDrain(h.ctx);
    try {
      for (let attempt = 1; attempt <= MAX_OUTBOX_ATTEMPTS; attempt++) {
        h.hcs.failNext = true;
        await drain.runOnce();
        skipBackoff();
      }
    } finally {
      drain.stop();
    }

    const row = h.repos.outbox.get(id);
    expect(row?.state).toBe("failed");
    expect(row?.attempts).toBe(MAX_OUTBOX_ATTEMPTS);
    expect(row?.last_error).toBe("simulated HCS outage");
    // The payload survives for an operator to replay by hand once the topic is fixed.
    expect(row?.payload).toBe(JSON.stringify({ type: "released" }));
    // And it is out of the way: the message behind it went through on the very first pass.
    expect(h.repos.outbox.get(behind)?.state).toBe("sent");
    expect(h.repos.outbox.countByState("pending")).toBe(0);
  });
});
