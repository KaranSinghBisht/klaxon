import type { ReleaseOk, ReleaseRequestBody } from "@klaxon/core";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { PrivateKey, Transaction, type TransferTransaction } from "@x402/hedera";
import { describe, expect, it } from "vitest";
import { buildPayClient } from "../src/client.js";
import { httpReleaseTransport } from "../src/transport.js";

const H = `8f2e${"a3".repeat(30)}`;
const WITNESS_URL = "https://klaxon-witness.fly.dev";
const WITNESS_ACCOUNT = "0.0.1234567";
const RUNNER = "0.0.9876543";
const FEE_PAYER = "0.0.7162784";
const AMOUNT = "100000";

function requirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.0",
    amount: AMOUNT,
    payTo: WITNESS_ACCOUNT,
    maxTimeoutSeconds: 120,
    extra: { memo: H, feePayer: FEE_PAYER },
    ...over,
  };
}

function paymentRequired(accepts: PaymentRequirements[]): PaymentRequired {
  return {
    x402Version: 2,
    error: "KLAXON release requires payment; transaction memo MUST equal the commitment hash",
    resource: { url: `${WITNESS_URL}/release/${H}` },
    accepts,
  };
}

const OK: ReleaseOk = {
  ok: true,
  h: H,
  share_b: { v: 1, epk: "A".repeat(43), ct: "Zm9v", tag: "B".repeat(22) },
  hcs: { sequence_number: "42", consensus_timestamp: "1788848437.031176249" },
};

const BODY = { C: { v: 1 }, jwt: "a.b.c", sig: "c2ln" } as unknown as ReleaseRequestBody;

/**
 * A witness that answers 402 once, then 200 — everything the client does in between (selecting
 * requirements, spend controls, the anti-redirect policy, the memo-stamping signer) runs offline,
 * because only the *server* ever talks to the facilitator.
 */
function fakeWitness(accepts: PaymentRequirements[]) {
  const signatures: string[] = [];
  // `wrapFetchWithPayment` hands its inner fetch a `Request`, never (input, init).
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    const signature = headers.get("PAYMENT-SIGNATURE");
    if (signature === null) {
      return new Response(JSON.stringify(paymentRequired(accepts)), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired(accepts)) },
      });
    }
    signatures.push(signature);
    return new Response(JSON.stringify(OK), {
      status: 200,
      headers: {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader({
          success: true,
          transaction: "0.0.9876543@1788848437.031176249",
          network: "hedera:testnet",
          payer: RUNNER,
        }),
      },
    });
  };
  return { fetchImpl, signatures };
}

function payFetchFor(accepts: PaymentRequirements[]) {
  const witness = fakeWitness(accepts);
  const client = buildPayClient({
    payAccount: RUNNER,
    payKey: PrivateKey.generateECDSA(),
    witnessAccount: WITNESS_ACCOUNT,
    maxTinybars: "200000",
  });
  return { ...witness, payFetch: wrapFetchWithPayment(witness.fetchImpl, client) };
}

describe("402 → memo-stamped payment → release", () => {
  it("answers the witness's 402 with a transfer whose memo is the commitment hash", async () => {
    const { payFetch, signatures } = payFetchFor([requirements()]);

    const res = await httpReleaseTransport(WITNESS_URL, payFetch).release(H, BODY);

    expect(res.status).toBe(200);
    expect(res.payTx).toBe("0.0.9876543@1788848437.031176249");
    expect(signatures).toHaveLength(1);

    const payload = decodePaymentSignatureHeader(String(signatures[0]));
    const b64 = payload.payload.transaction as string;
    const tx = Transaction.fromBytes(Buffer.from(b64, "base64")) as TransferTransaction;
    expect(tx.transactionMemo).toBe(H);
    expect(tx.hbarTransfers.get(RUNNER)?.toTinybars().toString()).toBe(`-${AMOUNT}`);
    expect(tx.hbarTransfers.get(WITNESS_ACCOUNT)?.toTinybars().toString()).toBe(AMOUNT);
  });

  it("will not pay a 402 that redirects the transfer to another account", async () => {
    const { payFetch, signatures } = payFetchFor([requirements({ payTo: "0.0.6666666" })]);
    await expect(httpReleaseTransport(WITNESS_URL, payFetch).release(H, BODY)).rejects.toThrow();
    expect(signatures).toHaveLength(0);
  });

  it("will not pay more than max-tinybars", async () => {
    const witness = fakeWitness([requirements({ amount: "999999999" })]);
    const client = buildPayClient({
      payAccount: RUNNER,
      payKey: PrivateKey.generateECDSA(),
      witnessAccount: WITNESS_ACCOUNT,
      maxTinybars: "200000",
    });
    const payFetch = wrapFetchWithPayment(witness.fetchImpl, client);
    await expect(httpReleaseTransport(WITNESS_URL, payFetch).release(H, BODY)).rejects.toThrow();
    expect(witness.signatures).toHaveLength(0);
  });
});
