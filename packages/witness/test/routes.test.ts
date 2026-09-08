import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startJwksSnapshot } from "../src/jobs/jwks-snapshot.js";
import { TOPIC_ID } from "./helpers/fixtures.js";
import { createHarness, type Harness, PROJECT_ID } from "./helpers/harness.js";

describe("GET /health", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("reports every dependency and answers 200 when all are up", async () => {
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      db: true,
      facilitator: true,
      mirror: true,
      sepolia_cursor_lag_s: 0,
    });
  });

  it("fails closed when the mirror node is unreachable", async () => {
    h.payment.mirrorMode = "infra";
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, mirror: false });
  });

  it("fails closed when the Sepolia cursor has never advanced", async () => {
    h.registry.lag = null;
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, sepolia_cursor_lag_s: null });
  });

  it("fails closed when the Sepolia cursor is far behind", async () => {
    h.registry.lag = 3600;
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
  });
});

describe("GET /.well-known/klaxon.json", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
    h.registerProject();
  });

  afterEach(async () => {
    await h.close();
  });

  it("serves the manifest shape PROTOCOL §4 fixes", async () => {
    const res = await h.app.inject({ method: "GET", url: "/.well-known/klaxon.json" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      klaxon: 1,
      release_endpoint: "https://witness.test/release/{h}",
      price: { amount: "100000", asset: "0.0.0", network: "hedera:testnet" },
      facilitator: "https://api.testnet.blocky402.com",
      hedera_account: "0.0.4820",
      submit_key: h.hcs.submitKeyDer,
      memo_rule: "transaction memo MUST equal the commitment hash h",
      projects: [
        {
          project_id: PROJECT_ID,
          topic_id: TOPIC_ID,
          policy_hash: h.policyHash,
          current_gen: "1",
          revoked: false,
        },
      ],
    });
    expect((res.json() as { verify: string }).verify).toContain(`--topic ${TOPIC_ID}`);
  });

  it("filters to one project when asked", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/.well-known/klaxon.json?project=${"f".repeat(64)}`,
    });
    expect((res.json() as { projects: unknown[] }).projects).toEqual([]);
  });
});

describe("jwks snapshot job", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
    h.registerProject();
  });

  afterEach(async () => {
    await h.close();
  });

  it("publishes the keyset once and stays quiet while it is unchanged", async () => {
    const job = startJwksSnapshot(h.ctx);
    try {
      expect(await job.runOnce()).toBe(true);
      expect(h.hcs.ofType("jwks")).toHaveLength(1);
      expect(h.hcs.ofType("jwks")[0]?.message.keys).toHaveLength(1);

      expect(await job.runOnce()).toBe(false);
      expect(h.hcs.ofType("jwks")).toHaveLength(1);
    } finally {
      job.stop();
    }
    expect(h.repos.jwks.latest()?.hcs_seq).toBe("1");
  });
});
