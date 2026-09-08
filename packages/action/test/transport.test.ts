import type { ReleaseOk, ReleaseRefused, ReleaseRequestBody } from "@klaxon/core";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { httpReleaseTransport } from "../src/transport.js";

const H = "8f2e".concat("a3".repeat(30));
const WITNESS = "https://klaxon-witness.fly.dev/";

const OK: ReleaseOk = {
  ok: true,
  h: H,
  share_b: { v: 1, epk: "A".repeat(43), ct: "Zm9v", tag: "B".repeat(22) },
  hcs: { sequence_number: "42", consensus_timestamp: "1788848437.031176249" },
};

const REFUSED: ReleaseRefused = {
  ok: false,
  h: H,
  class: "policy",
  check: 5,
  reason: "deploy job uses an unpinned action",
};

const BODY = {
  C: { v: 1, project_id: "ab".repeat(32) },
  jwt: "header.payload.signature",
  sig: "c2ln",
} as unknown as ReleaseRequestBody;

const PAYMENT_RESPONSE = encodePaymentResponseHeader({
  success: true,
  transaction: "0.0.1@1.2",
  network: "hedera:testnet",
  payer: "0.0.5",
});

describe("httpReleaseTransport", () => {
  it("posts the release body and reads pay_tx out of PAYMENT-RESPONSE", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const transport = httpReleaseTransport(WITNESS, async (url, init) => {
      seen.push({ url, ...(init ? { init } : {}) });
      return new Response(JSON.stringify(OK), {
        status: 200,
        headers: { "PAYMENT-RESPONSE": PAYMENT_RESPONSE },
      });
    });

    const res = await transport.release(H, BODY);

    expect(seen[0]?.url).toBe(`https://klaxon-witness.fly.dev/release/${H}`);
    expect(seen[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(OK);
    expect(res.payTx).toBe("0.0.1@1.2");
    expect(transport.lastRefusal()).toBeNull();
  });

  it("surfaces a 403 refusal body unchanged", async () => {
    const transport = httpReleaseTransport(
      WITNESS,
      async () => new Response(JSON.stringify(REFUSED), { status: 403 }),
    );

    const res = await transport.release(H, BODY);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(REFUSED);
    expect(res.payTx).toBe("");
    expect(transport.lastRefusal()).toEqual(REFUSED);
  });

  it("names the status when the witness answers with something that is not JSON", async () => {
    const transport = httpReleaseTransport(
      WITNESS,
      async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );
    await expect(transport.release(H, BODY)).rejects.toThrow(/502.*non-JSON/);
  });

  it("names the status when the JSON is not a release response", async () => {
    const transport = httpReleaseTransport(
      WITNESS,
      async () => new Response(JSON.stringify({ message: "nope" }), { status: 500 }),
    );
    await expect(transport.release(H, BODY)).rejects.toThrow(/500.*unrecognised/);
  });

  it("reports a network failure without a response", async () => {
    const transport = httpReleaseTransport(WITNESS, async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(transport.release(H, BODY)).rejects.toThrow(/no response/);
  });

  it("refuses a released share that arrived without a settled payment", async () => {
    const transport = httpReleaseTransport(
      WITNESS,
      async () => new Response(JSON.stringify(OK), { status: 200 }),
    );
    await expect(transport.release(H, BODY)).rejects.toThrow(/PAYMENT-RESPONSE/);
  });
});
