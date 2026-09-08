import { describe, expect, it } from "vitest";
import type { AttemptRecord } from "../src/envelope.js";
import type { Payment } from "../src/mirror/payments.js";
import { txIdKey } from "../src/mirror/payments.js";
import { pairPayments } from "../src/pair.js";

const H = "1".repeat(64);
const PAY = "0.0.7162784-1788848300-493972399";
const PAID_AT = "1788848310.000000000";

function pay(overrides: Partial<Payment> = {}): Payment {
  return {
    transactionId: PAY,
    consensusTimestamp: PAID_AT,
    memo: H,
    amount: 100000n,
    ...overrides,
  };
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  const payTx = overrides.payTx ?? PAY;
  return {
    type: "released",
    h: H,
    commitment: {},
    jwt: "jwt",
    sig: "sig",
    payTx,
    payTxKey: txIdKey(payTx),
    consensusTimestamp: "1788848313.000000000",
    sequenceNumber: 1,
    projectId: "a".repeat(64),
    declaredTs: "2026-09-10T00:05:03.000Z",
    ...overrides,
  };
}

/** Comfortably past every grace window used below. */
const LATER = new Date(1_788_848_999_000);

describe("PROTOCOL §9 pairing", () => {
  it("accepts exactly one released per payment", () => {
    const result = pairPayments([pay()], [attempt()], { now: LATER });
    expect(result.findings).toHaveLength(0);
    expect(result.pairs[0]?.released).toHaveLength(1);
    expect(result.pairs[0]?.withheld).toBe(false);
  });

  it("accepts any number of refused for one payment", () => {
    const result = pairPayments(
      [pay()],
      [
        attempt({ type: "refused", consensusTimestamp: "1788848311.000000000" }),
        attempt({ type: "refused", consensusTimestamp: "1788848312.000000000" }),
        attempt({ consensusTimestamp: "1788848314.000000000" }),
      ],
      { now: LATER },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.pairs[0]?.refused).toHaveLength(2);
    expect(result.pairs[0]?.released).toHaveLength(1);
  });

  it("reports WITNESS_WITHHELD for a payment the witness never answered", () => {
    const result = pairPayments([pay()], [], { now: LATER });
    expect(result.pairs[0]?.withheld).toBe(true);
    expect(result.findings.map((f) => f.code)).toEqual(["WITNESS_WITHHELD"]);
    expect(result.findings[0]?.severity).toBe("violation");
    expect(result.findings[0]?.pay_tx).toBe(PAY);
  });

  it("holds fire inside the grace window so mirror lag is not a false accusation", () => {
    const justPaid = new Date(1_788_848_320_000); // 10 s after consensus
    const result = pairPayments([pay()], [], { now: justPaid, graceSeconds: 30 });
    expect(result.pairs[0]?.pending).toBe(true);
    expect(result.pairs[0]?.withheld).toBe(false);
    expect(result.findings).toHaveLength(0);

    const past = new Date(1_788_848_341_000); // 31 s after consensus
    const after = pairPayments([pay()], [], { now: past, graceSeconds: 30 });
    expect(after.pairs[0]?.withheld).toBe(true);
    expect(after.findings.map((f) => f.code)).toEqual(["WITNESS_WITHHELD"]);
  });

  it("reports DOUBLE_RELEASE when one payment buys two releases", () => {
    const result = pairPayments(
      [pay()],
      [attempt(), attempt({ h: "2".repeat(64), sequenceNumber: 2 })],
      { now: LATER },
    );
    expect(result.findings.map((f) => f.code)).toEqual(["DOUBLE_RELEASE"]);
    expect(result.pairs[0]?.released).toHaveLength(2);
  });

  it("reports ORDERING when a message precedes the payment it claims to answer", () => {
    const result = pairPayments(
      [pay()],
      [attempt({ consensusTimestamp: "1788848309.999999999" })],
      {
        now: LATER,
      },
    );
    expect(result.findings.map((f) => f.code)).toEqual(["ORDERING"]);
  });

  it("pairs across the @ and dashed forms of the same transaction id", () => {
    const result = pairPayments(
      [pay()],
      [
        attempt({
          payTx: "0.0.7162784@1788848300.493972399",
          payTxKey: txIdKey("0.0.7162784@1788848300.493972399"),
        }),
      ],
      {
        now: LATER,
      },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.pairs[0]?.released).toHaveLength(1);
  });

  it("reports a released message with no settled payment behind it", () => {
    const result = pairPayments(
      [],
      [attempt({ payTx: "0.0.1-1-1", payTxKey: txIdKey("0.0.1-1-1") })],
      {
        now: LATER,
      },
    );
    expect(result.findings.map((f) => f.code)).toEqual(["RELEASE_WITHOUT_PAYMENT"]);
    expect(result.orphans).toHaveLength(1);
  });

  it("does not flag an unpaired refusal", () => {
    const result = pairPayments(
      [],
      [attempt({ type: "refused", payTx: "0.0.1-1-1", payTxKey: txIdKey("0.0.1-1-1") })],
      { now: LATER },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.orphans).toHaveLength(1);
  });
});
