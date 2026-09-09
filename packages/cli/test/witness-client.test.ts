import { b64u, verifyOperatorRequest } from "@klaxon/core";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { WitnessClient } from "../src/witness-client.js";
import {
  fakeFetch,
  TEST_OPERATOR_PRIV,
  TEST_OPERATOR_PUB,
  TEST_PROJECT_ID,
  TEST_PUB,
} from "./helpers.js";

const B = b64u.encode(Buffer.alloc(32, 7));
const B_HASH = "c".repeat(64);
const NOW = new Date("2026-09-08T12:00:00.000Z");

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const { impl, calls } = fakeFetch(routes);
  return {
    calls,
    witness: new WitnessClient({
      baseUrl: "https://witness.example/",
      operator: { privatekey: TEST_OPERATOR_PRIV, pubkey: TEST_OPERATOR_PUB },
      fetchImpl: impl,
      now: () => NOW,
    }),
  };
}

describe("operator-signed requests", () => {
  it("signs the exact bytes on the wire, over METHOD/path/ts", async () => {
    const { witness, calls } = client({
      "/shares": () => ({ json: { ok: true, b: B, b_hash: B_HASH } }),
    });
    await witness.shares(TEST_PROJECT_ID, "DEPLOYER_PRIVATE_KEY", "1");

    const call = calls[0];
    if (!call) throw new Error("no request recorded");
    expect(call.method).toBe("POST");
    expect(call.headers["x-klaxon-operator-pub"]).toBe(TEST_OPERATOR_PUB);
    expect(call.headers["x-klaxon-ts"]).toBe(NOW.toISOString());
    expect(
      verifyOperatorRequest(TEST_OPERATOR_PUB, call.headers, "POST", "/shares", call.body, NOW),
    ).toEqual({
      ok: true,
    });
    expect(JSON.parse(call.body.toString("utf8"))).toEqual({
      project_id: TEST_PROJECT_ID,
      secret: "DEPLOYER_PRIVATE_KEY",
      gen: "1",
    });
  });

  it("a signature over different bytes does not verify — the body is bound", async () => {
    const { witness, calls } = client({
      "/shares": () => ({ json: { ok: true, b: B, b_hash: B_HASH } }),
    });
    await witness.shares(TEST_PROJECT_ID, "S", "1");
    const call = calls[0];
    if (!call) throw new Error("no request recorded");
    const tampered = Buffer.from(call.body.toString("utf8").replace('"1"', '"2"'), "utf8");
    expect(
      verifyOperatorRequest(TEST_OPERATOR_PUB, call.headers, "POST", "/shares", tampered, NOW),
    ).toMatchObject({ ok: false });
  });

  it("signs the pathname the witness will see, not the whole URL", async () => {
    const { impl, calls } = fakeFetch({
      "/rotate": () => ({ json: { ok: true, b: B, b_hash: B_HASH } }),
    });
    const witness = new WitnessClient({
      baseUrl: "https://witness.example",
      operator: { privatekey: TEST_OPERATOR_PRIV, pubkey: TEST_OPERATOR_PUB },
      fetchImpl: impl,
      now: () => NOW,
    });
    await witness.rotate(TEST_PROJECT_ID, "S", "2");
    const call = calls[0];
    if (!call) throw new Error("no request recorded");
    expect(call.url).toBe("https://witness.example/rotate");
    expect(
      verifyOperatorRequest(TEST_OPERATOR_PUB, call.headers, "POST", "/rotate", call.body, NOW),
    ).toEqual({
      ok: true,
    });
  });
});

describe("routes", () => {
  it("parses /shares and /rotate", async () => {
    const { witness } = client({
      "/shares": () => ({ json: { ok: true, b: B, b_hash: B_HASH } }),
      "/rotate": () => ({ json: { ok: true, b: B, b_hash: B_HASH } }),
    });
    expect(await witness.shares(TEST_PROJECT_ID, "S", "1")).toEqual({
      ok: true,
      b: B,
      b_hash: B_HASH,
    });
    expect((await witness.rotate(TEST_PROJECT_ID, "S", "2")).b_hash).toBe(B_HASH);
  });

  it("coerces the revoke epoch whether it arrives as a number or a string", async () => {
    const numeric = client({ "/revoke": () => ({ json: { ok: true, epoch: 4 } }) });
    expect(await numeric.witness.revoke(TEST_PROJECT_ID, "leak")).toEqual({ epoch: 4 });
    const stringy = client({ "/revoke": () => ({ json: { ok: true, epoch: "4" } }) });
    expect(await stringy.witness.revoke(TEST_PROJECT_ID, "leak")).toEqual({ epoch: 4 });
  });

  it("registers a project", async () => {
    const { witness, calls } = client({ "/projects": () => ({ json: { ok: true } }) });
    await witness.registerProject({
      project_id: TEST_PROJECT_ID,
      repository_id: "1",
      repository: "acme/demo",
      member_pubkey: TEST_PUB,
      operator_pubkey: TEST_OPERATOR_PUB,
      topic_id: "0.0.1",
      ntfy_topic: "klaxon-aa",
    });
    expect(JSON.parse((calls[0] as { body: Buffer }).body.toString("utf8")).topic_id).toBe("0.0.1");
  });

  it("surfaces the witness's own refusal reason", async () => {
    const { witness } = client({
      "/shares": () => ({ status: 403, json: { ok: false, reason: "not your project" } }),
    });
    await expect(witness.shares(TEST_PROJECT_ID, "S", "1")).rejects.toThrowError(
      /not your project/,
    );
  });

  it("rejects a malformed share rather than writing an unusable .enc", async () => {
    const { witness } = client({
      "/shares": () => ({ json: { ok: true, b: "short", b_hash: B_HASH } }),
    });
    await expect(witness.shares(TEST_PROJECT_ID, "S", "1")).rejects.toThrowError(CliError);
  });
});

describe("manifest", () => {
  it("reads submit_key and hedera_account and tolerates extra fields", async () => {
    const { witness } = client({
      "/.well-known/klaxon.json": () => ({
        json: {
          klaxon: 1,
          submit_key: "302a300506032b6570032100aa",
          hedera_account: "0.0.9999",
          projects: [{ project_id: TEST_PROJECT_ID }],
          verify: "npx klaxon verify",
        },
      }),
    });
    const m = await witness.manifest();
    expect(m.submit_key).toBe("302a300506032b6570032100aa");
    expect(m.hedera_account).toBe("0.0.9999");
  });

  it("fails loudly when the manifest lacks the submit key init depends on", async () => {
    const { witness } = client({
      "/.well-known/klaxon.json": () => ({ json: { klaxon: 1, hedera_account: "0.0.1" } }),
    });
    await expect(witness.manifest()).rejects.toThrowError(/failed validation/);
  });
});
