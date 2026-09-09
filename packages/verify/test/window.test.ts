import { describe, expect, it } from "vitest";
import { verify } from "../src/index.js";
import type { FetchLike } from "../src/mirror/client.js";
import { exitCodeFor } from "../src/report.js";
import {
  buildCommitment,
  fakeRegistry,
  mintJwt,
  oidcKeys,
  POLICY_BYTES,
  payment,
  REGISTRY,
  released,
  TOPIC_ID,
  topicMessage,
  WITNESS,
} from "./helpers/scenario.js";

/** `--since`, on the second. */
const SINCE = "1788848300.000000000";
/** Two seconds before it: the payment settles just outside the requested window. */
const PAID_AT = "1788848298.000000000";
/** One second after it: the witness answers just inside the requested window. */
const ANSWERED_AT = "1788848301.000000000";
const TX = "0.0.10405046-1788848297-000000001";
const NOW = new Date(1_788_849_000_000);

/**
 * A mirror node that actually honours `timestamp=gte:`. `fakeNetwork` serves whatever it is
 * given regardless of the query, which is fine for every other test and useless for this one —
 * the whole defect lives in which timestamp each of the two reads is bounded by.
 */
function boundedMirror(messages: readonly unknown[], transactions: readonly unknown[]): FetchLike {
  const from = (url: URL): string | null => url.searchParams.get("timestamp")?.slice(4) ?? null;
  const keep = <T extends { consensus_timestamp: string }>(
    rows: readonly T[],
    gte: string | null,
  ) => (gte === null ? rows : rows.filter((r) => Number(r.consensus_timestamp) >= Number(gte)));

  return async (input) => {
    const url = new URL(input);
    if (url.hostname === "raw.githubusercontent.com") {
      return new Response(Buffer.from(POLICY_BYTES), { status: 200 });
    }
    const rows = url.pathname.includes("/messages")
      ? { messages: keep(messages as { consensus_timestamp: string }[], from(url)) }
      : { transactions: keep(transactions as { consensus_timestamp: string }[], from(url)) };
    return new Response(JSON.stringify({ ...rows, links: { next: null } }), { status: 200 });
  };
}

async function straddle() {
  const keys = await oidcKeys("gh-2026-09");
  const one = buildCommitment({ runId: "17000000001" });
  const jwt = await mintJwt(keys, 1_788_848_298, { h: one.h, runId: "17000000001" });
  return {
    keys,
    messages: [topicMessage(released({ ...one, payTx: TX, jwt }), ANSWERED_AT)],
    transactions: [payment(one.h, PAID_AT, TX)],
  };
}

describe("--since window", () => {
  it("does not report a release with no payment when the pair straddles the cutoff", async () => {
    const built = await straddle();
    const report = await verify(
      {
        topicId: TOPIC_ID,
        witnessAccount: WITNESS,
        registryAddress: REGISTRY,
        mirrorUrl: "https://mirror.example",
        sinceTimestamp: SINCE,
        graceSeconds: 30,
        now: NOW,
      },
      {
        fetch: boundedMirror(built.messages, built.transactions),
        registry: fakeRegistry(),
        jwks: { remote: built.keys.jwks },
      },
    );

    expect(report.findings.map((f) => f.code)).not.toContain("RELEASE_WITHOUT_PAYMENT");
    expect(report.counts.orphan_messages).toBe(0);
    expect(report.violations).toBe(0);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("does not audit the payments read only to resolve the straddle", async () => {
    // The lookback payment answered nothing of its own: it must not be reported as withheld, and
    // it must not appear in the counts, because it settled outside the window that was asked for.
    const built = await straddle();
    const report = await verify(
      {
        topicId: TOPIC_ID,
        witnessAccount: WITNESS,
        registryAddress: REGISTRY,
        mirrorUrl: "https://mirror.example",
        sinceTimestamp: SINCE,
        graceSeconds: 30,
        now: NOW,
      },
      {
        fetch: boundedMirror([], built.transactions),
        registry: fakeRegistry(),
        jwks: { remote: built.keys.jwks },
      },
    );

    expect(report.counts.payments_found).toBe(0);
    expect(report.counts.withheld).toBe(0);
    expect(report.findings.map((f) => f.code)).not.toContain("WITNESS_WITHHELD");
    expect(exitCodeFor(report)).toBe(0);
  });
});
