import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verify } from "../src/index.js";
import { exitCodeFor, renderHuman } from "../src/report.js";
import { fakeNetwork, fakeRegistry, REGISTRY, TOPIC_ID, WITNESS } from "./helpers/scenario.js";

interface Fixture {
  messages: unknown[];
  transactions: unknown[];
  expected: {
    paired: { h: string; pay_tx: string; secret: string; gen: string };
    withheld: { h: string; pay_tx: string };
  };
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/emergency.json", import.meta.url)), "utf8"),
) as Fixture;

/** Well past the grace window on both payments in the fixture. */
const NOW = new Date(1_789_001_000_000);

function run(overrides: Partial<Fixture> = {}) {
  const net = fakeNetwork({
    messages: overrides.messages ?? fixture.messages,
    transactions: overrides.transactions ?? fixture.transactions,
    policyBytes: null,
  });
  return verify(
    {
      topicId: TOPIC_ID,
      witnessAccount: WITNESS,
      registryAddress: REGISTRY,
      mirrorUrl: "https://mirror.example",
      graceSeconds: 30,
      now: NOW,
    },
    { fetch: net.fetch, registry: fakeRegistry() },
  );
}

describe("PROTOCOL §7 emergency recoveries", () => {
  it("pairs an emergency with its payment exactly like a released", async () => {
    const report = await run();

    expect(report.counts.payments_found).toBe(2);
    expect(report.counts.emergency).toBe(1);
    expect(report.counts.released).toBe(0);
    expect(report.counts.refused).toBe(0);

    const rescue = report.attempts.find((a) => a.type === "emergency");
    expect(rescue).toBeDefined();
    expect(rescue?.h).toBe(fixture.expected.paired.h);
    expect(rescue?.payTx).toBe(fixture.expected.paired.pay_tx);
    expect(rescue?.secret).toBe(fixture.expected.paired.secret);
    expect(rescue?.gen).toBe(fixture.expected.paired.gen);
    // h is re-derived from the message's own fields by our own canonicalizer, and it agrees
    // with the memo the operator actually paid with.
    expect(rescue?.hRecomputed).toBe(true);
    expect(rescue?.findings).toEqual([]);
  });

  it("marks the JWT, signature and policy rows n/a rather than failing them", async () => {
    const report = await run();
    const rescue = report.attempts.find((a) => a.type === "emergency");
    expect(rescue?.sigValid).toBeNull();
    expect(rescue?.audBinds).toBeNull();
    expect(rescue?.claimsMatch).toBeNull();
    expect(rescue?.jwt.ok).toBeNull();
    expect(rescue?.policy.state).toBe("n/a");
    expect(rescue?.envSecret.state).toBe("n/a");

    // Those rows drop out of their denominators; `h recomputed` keeps the emergency in.
    expect(report.tallies.jwts_valid).toEqual({ passed: 0, total: 0 });
    expect(report.tallies.aud_binds).toEqual({ passed: 0, total: 0 });
    expect(report.tallies.h_recomputed).toEqual({ passed: 1, total: 1 });
    expect(report.tallies.policy_matched).toEqual({ passed: 0, total: 0 });
  });

  it("reports WITNESS_WITHHELD for an emergency payment with no message", async () => {
    const report = await run();
    expect(report.counts.withheld).toBe(1);
    const withheld = report.findings.filter((f) => f.code === "WITNESS_WITHHELD");
    expect(withheld).toHaveLength(1);
    expect(withheld[0]?.pay_tx).toBe(fixture.expected.withheld.pay_tx);
    expect(withheld[0]?.h).toBe(fixture.expected.withheld.h);
    expect(report.violations).toBe(1);
    expect(exitCodeFor(report)).toBe(1);
  });

  it("does not call a payment withheld once its emergency is published", async () => {
    const report = await run({ transactions: [fixture.transactions[0]] });
    expect(report.counts.withheld).toBe(0);
    expect(report.violations).toBe(0);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("counts two answers for one payment as DOUBLE_RELEASE", async () => {
    // Two distinct messages citing the same pay_tx — what a real double-publish looks like.
    const first = fixture.messages[0] as Record<string, unknown>;
    const second = { ...first, consensus_timestamp: "1789000011.500000000", sequence_number: 42 };
    const report = await run({
      messages: [first, second],
      transactions: [fixture.transactions[0]],
    });
    expect(report.counts.double_releases).toBe(1);
    expect(report.findings.map((f) => f.code)).toContain("DOUBLE_RELEASE");
  });

  it("catches an emergency whose h does not match its own fields", async () => {
    const forged = {
      klaxon: 1,
      type: "emergency",
      ts: "2026-09-12T04:11:07.000Z",
      project_id: "a".repeat(64),
      h: fixture.expected.paired.h,
      secret: "DEPLOYER_PRIVATE_KEY",
      gen: "9", // the commitment no longer hashes to the h it claims, or to the memo paid
      pay_tx: fixture.expected.paired.pay_tx,
    };
    const report = await run({
      messages: [
        {
          chunk_info: null,
          consensus_timestamp: "1789000009.120000000",
          message: Buffer.from(JSON.stringify(forged), "utf8").toString("base64"),
          sequence_number: 41,
          topic_id: TOPIC_ID,
        },
      ],
      transactions: [fixture.transactions[0]],
    });
    expect(report.findings.map((f) => f.code)).toContain("H_MISMATCH");
    expect(report.tallies.h_recomputed).toEqual({ passed: 0, total: 1 });
    expect(exitCodeFor(report)).toBe(1);
  });

  it("shows the emergency count in the human block", async () => {
    const text = renderHuman(await run());
    expect(text).toContain("emergency");
    expect(text).toMatch(/emergency\s+1/);
    expect(text).toContain("WITNESS WITHHELD");
  });

  it("does not report a documented --no-pay recovery as a release nobody paid for", async () => {
    // `klaxon emergency --no-pay` is a break-glass path with no payment by design (PROTOCOL §7).
    // A documented feature must not turn the honest report red.
    const report = await run({ messages: [noPay()], transactions: [] });

    expect(report.counts.emergency_unpaid).toBe(1);
    expect(report.counts.orphan_messages).toBe(0);
    expect(report.findings.map((f) => f.code)).not.toContain("RELEASE_WITHOUT_PAYMENT");
    expect(report.violations).toBe(0);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("gives the --no-pay recovery its own line rather than dropping it", async () => {
    const text = renderHuman(await run({ messages: [noPay()], transactions: [] }));
    expect(text).toMatch(/emergency --no-pay\s+1/);
    expect(text).toContain("no payment by design");
  });
});

/** The same recovery the fixture carries, minus the `pay_tx` — what `--no-pay` publishes. */
function noPay(): unknown {
  const paired = fixture.messages[0] as { message: string; consensus_timestamp: string };
  const body = JSON.parse(Buffer.from(paired.message, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
  delete body.pay_tx;
  return {
    chunk_info: null,
    consensus_timestamp: paired.consensus_timestamp,
    message: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
    sequence_number: 77,
    topic_id: TOPIC_ID,
    payer_account_id: WITNESS,
  };
}
