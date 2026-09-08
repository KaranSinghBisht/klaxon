import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startOutboxDrain } from "../src/jobs/outbox-drain.js";
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
