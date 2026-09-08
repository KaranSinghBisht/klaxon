import { describe, expect, it } from "vitest";
import { verify } from "../src/index.js";
import { exitCodeFor, renderHuman, type VerifyReport } from "../src/report.js";
import {
  buildCommitment,
  fakeNetwork,
  fakeRegistry,
  mintJwt,
  type OidcKeys,
  oidcKeys,
  POLICY_BYTES,
  PROJECT_ID,
  payment,
  REGISTRY,
  refused,
  released,
  TOPIC_ID,
  topicMessage,
  WITNESS,
} from "./helpers/scenario.js";

const PAID_1 = "1788848310.000000000";
const PAID_2 = "1788848320.000000000";
const PAID_3 = "1788848330.000000000";
const TX_1 = "0.0.10405046-1788848300-000000001";
const TX_2 = "0.0.10405046-1788848301-000000002";
const TX_3 = "0.0.10405046-1788848302-000000003";
/** Well past the 30 s grace window on every payment below. */
const NOW = new Date(1_788_849_000_000);

interface Built {
  keys: OidcKeys;
  messages: unknown[];
  transactions: unknown[];
}

/** One clean release, one honest refusal, one payment the witness never answered. */
async function baseline(): Promise<Built> {
  const keys = await oidcKeys("gh-2026-09");

  const one = buildCommitment({ runId: "17000000001" });
  const jwt1 = await mintJwt(keys, 1_788_848_310, { h: one.h, runId: "17000000001" });

  // The money shot: a job with no `environment` claim. `C` records the absence honestly as
  // "(none)", the witness refuses at check 3, and the runner still paid for the refusal.
  const two = buildCommitment({ runId: "17000000002", environment: "(none)" });
  const jwt2 = await mintJwt(keys, 1_788_848_320, {
    h: two.h,
    environment: null,
    runId: "17000000002",
  });

  return {
    keys,
    messages: [
      topicMessage(released({ ...one, payTx: TX_1, jwt: jwt1 }), "1788848313.000000000"),
      topicMessage(
        refused({
          ...two,
          payTx: TX_2,
          jwt: jwt2,
          class: "auth",
          check: 3,
          reason: "no environment claim",
        }),
        "1788848323.000000000",
      ),
    ],
    transactions: [
      payment(one.h, PAID_1, TX_1),
      payment(two.h, PAID_2, TX_2),
      payment("9".repeat(64), PAID_3, TX_3),
    ],
  };
}

async function run(
  built: Built,
  overrides: {
    messages?: unknown[];
    transactions?: unknown[];
    policyBytes?: Uint8Array | null;
    policyStatus?: number;
    registry?: ReturnType<typeof fakeRegistry>;
    paginate?: boolean;
  } = {},
): Promise<VerifyReport> {
  const net = fakeNetwork({
    messages: overrides.messages ?? built.messages,
    transactions: overrides.transactions ?? built.transactions,
    policyBytes: overrides.policyBytes === undefined ? POLICY_BYTES : overrides.policyBytes,
    ...(overrides.policyStatus !== undefined ? { policyStatus: overrides.policyStatus } : {}),
    ...(overrides.paginate !== undefined ? { paginate: overrides.paginate } : {}),
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
    {
      fetch: net.fetch,
      registry: overrides.registry ?? fakeRegistry(),
      jwks: { remote: built.keys.jwks },
    },
  );
}

describe("verify end to end", () => {
  it("re-derives the whole history and names the withheld payment", async () => {
    const report = await run(await baseline());

    expect(report.counts).toMatchObject({
      payments_found: 3,
      released: 1,
      refused: 1,
      withheld: 1,
      pending: 0,
      double_releases: 0,
      incomplete_messages: 0,
    });
    expect(report.tallies.jwts_valid).toEqual({ passed: 2, total: 2 });
    expect(report.tallies.jwts_live).toBe(2);
    expect(report.tallies.aud_binds).toEqual({ passed: 2, total: 2 });
    expect(report.tallies.h_recomputed).toEqual({ passed: 2, total: 2 });
    expect(report.tallies.policy_matched).toEqual({ passed: 1, total: 1 });
    expect(report.tallies.env_secret).toEqual({ passed: 1, total: 1 });
    expect(report.tallies.policy_versions).toBe(1);
    expect(report.max_releases).toMatchObject({ ok: true });
    expect(report.max_releases.peak).toMatchObject({ count: 1, limit: 4, gen: "3" });

    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("WITNESS_WITHHELD");
    expect(codes.filter((c) => c === "WITNESS_WITHHELD")).toHaveLength(1);
    expect(report.findings.find((f) => f.code === "WITNESS_WITHHELD")?.pay_tx).toBe(TX_3);
    expect(report.violations).toBe(1);
    expect(exitCodeFor(report)).toBe(1);
  });

  it("does not count the refusal's policy failure against the witness", async () => {
    const report = await run(await baseline());
    const envFinding = report.findings.find((f) => f.code === "ENV_NOT_IN_POLICY");
    expect(envFinding?.severity).toBe("unverified");
    const refusedCheck = report.attempts.find((a) => a.type === "refused");
    expect(refusedCheck?.envSecret.state).toBe("fail");
    expect(refusedCheck?.claimsMatch).toBe(true);
    expect(refusedCheck?.refusal).toMatchObject({ class: "auth", check: 3 });
  });

  it("exits clean when nothing is withheld", async () => {
    const built = await baseline();
    const report = await run(built, { transactions: built.transactions.slice(0, 2) });
    expect(report.counts.withheld).toBe(0);
    expect(report.violations).toBe(0);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("reads a paginated topic", async () => {
    const built = await baseline();
    const report = await run(built, {
      transactions: built.transactions.slice(0, 2),
      paginate: true,
    });
    expect(report.counts.released).toBe(1);
    expect(report.counts.refused).toBe(1);
  });

  it("catches DOUBLE_RELEASE", async () => {
    const built = await baseline();
    const extra = buildCommitment({ runId: "17000000009" });
    const jwt = await mintJwt(built.keys, 1_788_848_310, { h: extra.h, runId: "17000000009" });
    const report = await run(built, {
      messages: [
        ...built.messages,
        topicMessage(released({ ...extra, payTx: TX_1, jwt }), "1788848315.000000000"),
      ],
      transactions: built.transactions.slice(0, 2),
    });
    expect(report.counts.double_releases).toBe(1);
    expect(report.findings.map((f) => f.code)).toContain("DOUBLE_RELEASE");
    expect(exitCodeFor(report)).toBe(1);
  });

  it("catches a released message that precedes its payment", async () => {
    const built = await baseline();
    const report = await run(built, {
      messages: [built.messages[0]],
      transactions: [built.transactions[0]],
    });
    expect(report.violations).toBe(0);

    const early = await run(built, {
      messages: [
        topicMessage(
          (built.messages[0] as { message: string }) && decode(built.messages[0]),
          "1788848309.000000000",
        ),
      ],
      transactions: [built.transactions[0]],
    });
    expect(early.findings.map((f) => f.code)).toContain("ORDERING");
  });

  it("catches a commitment that does not hash to its own h", async () => {
    const built = await baseline();
    const one = buildCommitment({ runId: "17000000001" });
    const jwt = await mintJwt(built.keys, 1_788_848_310, { h: one.h });
    const tampered = { ...one.C, run_attempt: "2" }; // h no longer matches C
    const report = await run(built, {
      messages: [
        topicMessage(
          released({ h: one.h, C: tampered, jwt, sig: one.sig, payTx: TX_1 }),
          "1788848313.000000000",
        ),
      ],
      transactions: [built.transactions[0]],
    });
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("H_MISMATCH");
    expect(codes).toContain("CLAIM_MISMATCH");
    expect(report.tallies.h_recomputed).toEqual({ passed: 0, total: 1 });
    expect(exitCodeFor(report)).toBe(1);
  });

  it("catches a policy that does not match what Sepolia had in force", async () => {
    const built = await baseline();
    const report = await run(built, {
      transactions: built.transactions.slice(0, 1),
      messages: [built.messages[0]],
      registry: fakeRegistry({ policyHash: "c".repeat(64) }),
    });
    expect(report.findings.map((f) => f.code)).toContain("POLICY_MISMATCH");
    expect(report.tallies.policy_matched).toEqual({ passed: 0, total: 1 });
    expect(exitCodeFor(report)).toBe(1);
  });

  it("says POLICY_UNVERIFIABLE for a repo it cannot read, rather than passing it", async () => {
    const built = await baseline();
    const report = await run(built, {
      transactions: built.transactions.slice(0, 1),
      messages: [built.messages[0]],
      policyBytes: null,
    });
    const finding = report.findings.find((f) => f.code === "POLICY_UNVERIFIABLE");
    expect(finding?.severity).toBe("unverified");
    expect(finding?.detail).toMatch(/private repo|not readable/);
    expect(report.violations).toBe(0);
    expect(report.unverified).toBeGreaterThan(0);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("catches a release published while the project was revoked", async () => {
    const built = await baseline();
    const revoke = {
      klaxon: 1,
      type: "revoke",
      ts: "2026-09-10T00:05:00.000Z",
      project_id: PROJECT_ID,
      reason: "worm detected",
      epoch: 4,
    };
    const report = await run(built, {
      transactions: built.transactions.slice(0, 1),
      messages: [topicMessage(revoke, "1788848311.000000000"), built.messages[0]],
    });
    expect(report.findings.map((f) => f.code)).toContain("RELEASE_WHILE_REVOKED");
    expect(exitCodeFor(report)).toBe(1);
  });

  it("clears the revocation window at the on-chain Unrevoked", async () => {
    const built = await baseline();
    const revoke = {
      klaxon: 1,
      type: "revoke",
      ts: "2026-09-10T00:05:00.000Z",
      project_id: PROJECT_ID,
      reason: "worm detected",
      epoch: 4,
    };
    const report = await run(built, {
      transactions: built.transactions.slice(0, 1),
      messages: [topicMessage(revoke, "1788848311.000000000"), built.messages[0]],
      registry: fakeRegistry({ unrevokes: [{ epoch: 5n, seconds: 1_788_848_312n }] }),
    });
    expect(report.findings.map((f) => f.code)).not.toContain("RELEASE_WHILE_REVOKED");
  });

  it("uses the jwks snapshot on the topic once the live key set has rotated", async () => {
    const built = await baseline();
    const snapshot = {
      klaxon: 1,
      type: "jwks",
      ts: "2026-09-09T00:00:00.000Z",
      project_id: PROJECT_ID,
      keys: [built.keys.publicJwk],
    };
    const net = fakeNetwork({
      messages: [topicMessage(snapshot, "1788848300.000000000"), built.messages[0]],
      transactions: [built.transactions[0]],
      policyBytes: POLICY_BYTES,
    });
    const report = await verify(
      {
        topicId: TOPIC_ID,
        witnessAccount: WITNESS,
        registryAddress: REGISTRY,
        mirrorUrl: "https://mirror.example",
        graceSeconds: 30,
        now: NOW,
      },
      {
        fetch: net.fetch,
        registry: fakeRegistry(),
        jwks: {
          remote: () => {
            throw Object.assign(new Error("no applicable key"), {
              code: "ERR_JWKS_NO_MATCHING_KEY",
            });
          },
        },
      },
    );
    expect(report.tallies.jwts_valid).toEqual({ passed: 1, total: 1 });
    expect(report.tallies.jwts_via_snapshot).toBe(1);
    expect(report.tallies.snapshot_timestamps).toEqual(["1788848300.000000000"]);
    expect(report.violations).toBe(0);
  });

  it("reports an incomplete chunk group without calling it withheld", async () => {
    const built = await baseline();
    const body = Buffer.from(JSON.stringify(decode(built.messages[0])), "utf8");
    const half = {
      chunk_info: {
        initial_transaction_id: { account_id: "0.0.9", transaction_valid_start: "1.000000001" },
        number: 1,
        total: 2,
      },
      consensus_timestamp: "1788848313.000000000",
      message: body.subarray(0, 40).toString("base64"),
      sequence_number: 1,
      topic_id: TOPIC_ID,
    };
    const report = await run(built, {
      messages: [half],
      transactions: built.transactions.slice(0, 1),
    });
    expect(report.counts.incomplete_messages).toBe(1);
    const incomplete = report.findings.find((f) => f.code === "MESSAGE_INCOMPLETE");
    expect(incomplete?.severity).toBe("unverified");
    // The payment now looks unanswered, which it is — but the incomplete group says why.
    expect(report.counts.withheld).toBe(1);
  });

  it("renders the block from Appendix A §6.6", async () => {
    const built = await baseline();
    const text = renderHuman(await run(built));
    for (const label of [
      "payments found",
      "released",
      "refused",
      "withheld",
      "jwts valid at consensus",
      "aud binds commitment",
      "h recomputed from C",
      "policy hash matched",
      "env + secret in policy",
      "max_releases respected",
      "double releases",
      "VIOLATIONS 1",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toContain(`KLAXON verify — topic ${TOPIC_ID} · witness ${WITNESS}`);
    expect(text).toContain("VIOLATION WITNESS_WITHHELD");
  });

  it("serialises to JSON with no BigInt left in it", async () => {
    const report = await run(await baseline());
    const json = JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(JSON.parse(json).klaxon_verify).toBe(1);
    expect(JSON.parse(json).counts.withheld).toBe(1);
  });

  it("rejects malformed identifiers before it touches the network", async () => {
    await expect(
      verify({ topicId: "nope", witnessAccount: WITNESS, registryAddress: REGISTRY }),
    ).rejects.toThrow(/--topic/);
    await expect(
      verify({ topicId: TOPIC_ID, witnessAccount: "0.0", registryAddress: REGISTRY }),
    ).rejects.toThrow(/--witness/);
    await expect(
      verify({ topicId: TOPIC_ID, witnessAccount: WITNESS, registryAddress: "0xdead" }),
    ).rejects.toThrow(/--registry/);
  });
});

function decode(raw: unknown): unknown {
  return JSON.parse(Buffer.from((raw as { message: string }).message, "base64").toString("utf8"));
}
