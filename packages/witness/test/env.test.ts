import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

const REQUIRED: NodeJS.ProcessEnv = {
  KLAXON_PUBLIC_URL: "https://witness.test",
  WITNESS_MASTER: "5a".repeat(32),
  HEDERA_OPERATOR_ID: "0.0.4820",
  HEDERA_OPERATOR_KEY: "0xabc",
  KLAXON_REGISTRY: "0x1111111111111111111111111111111111111111",
};

/** B §9: nothing is hardcoded, everything comes from `process.env`, and absence throws at boot. */
describe("witness configuration", () => {
  it("throws when a required variable is absent", () => {
    expect(() => loadEnv({})).toThrow(/invalid witness configuration/);
  });

  it("names every missing variable", () => {
    try {
      loadEnv({});
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      for (const key of Object.keys(REQUIRED)) expect(message).toContain(key);
    }
  });

  it("accepts a hex or base64 master and decodes it to 32 bytes", () => {
    expect(loadEnv(REQUIRED).WITNESS_MASTER).toHaveLength(32);
    const base64 = Buffer.alloc(32, 7).toString("base64");
    expect(
      loadEnv({ ...REQUIRED, WITNESS_MASTER: base64 }).WITNESS_MASTER.equals(Buffer.alloc(32, 7)),
    ).toBe(true);
  });

  it("rejects a master that is not 32 bytes", () => {
    const short = Buffer.alloc(16, 1).toString("hex").padEnd(32, "0");
    expect(() => loadEnv({ ...REQUIRED, WITNESS_MASTER: short })).toThrow(/32 bytes/);
  });

  it("defaults the payee to the Hedera operator", () => {
    expect(loadEnv(REQUIRED).witnessAccount).toBe("0.0.4820");
    expect(loadEnv({ ...REQUIRED, KLAXON_WITNESS_ACCOUNT: "0.0.999" }).witnessAccount).toBe(
      "0.0.999",
    );
  });

  it("does not revoke on budget exhaustion by default (D16)", () => {
    expect(loadEnv(REQUIRED).KLAXON_REVOKE_ON_BUDGET).toBe(false);
    expect(loadEnv({ ...REQUIRED, KLAXON_REVOKE_ON_BUDGET: "true" }).KLAXON_REVOKE_ON_BUDGET).toBe(
      true,
    );
  });

  it("ships the verified defaults", () => {
    const config = loadEnv(REQUIRED);
    expect(config.X402_FACILITATOR).toBe("https://api.testnet.blocky402.com");
    expect(config.X402_NETWORK).toBe("hedera:testnet");
    expect(config.X402_PRICE_TINYBAR).toBe("100000");
    expect(config.MIRROR_NODE).toBe("https://testnet.mirrornode.hedera.com");
    expect(config.SEPOLIA_RPC_URL).toBe("https://ethereum-sepolia-rpc.publicnode.com");
    expect(config.CONFIRMATIONS).toBe(3);
    expect(config.KLAXON_PAYMENT_MAX_AGE_S).toBe(600);
    expect(config.KLAXON_CLOCK_TOLERANCE_S).toBe(60);
  });

  it("rejects a registry address that is not an address", () => {
    expect(() => loadEnv({ ...REQUIRED, KLAXON_REGISTRY: "not-an-address" })).toThrow();
  });
});
