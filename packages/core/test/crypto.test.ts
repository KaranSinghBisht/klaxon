import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "../src/crypto/aead.js";
import {
  generateDataKey,
  joinShares,
  otherShare,
  shareHash,
  splitKey,
} from "../src/crypto/datakey.js";
import { eciesOpen, eciesSeal } from "../src/crypto/ecies.js";
import { generateEphemeral, signCommitment, verifyCommitmentSig } from "../src/crypto/ephemeral.js";
import {
  assertNotLeaked,
  clearSecretRegistry,
  registerSecretMaterial,
} from "../src/crypto/mask.js";
import { KlaxonError } from "../src/errors.js";

const H = "8f2e".padEnd(64, "a");
const AAD = { project_id: "0".repeat(64), secret: "DEPLOYER_PRIVATE_KEY", gen: "1" };

describe("data key split", () => {
  it("round-trips over random data and both shares differ from the key", () => {
    for (let i = 0; i < 50; i++) {
      const dk = generateDataKey();
      const { a, b } = splitKey(dk);
      expect(joinShares(a, b)).toEqual(dk);
      expect(a.equals(dk)).toBe(false);
      expect(b.equals(dk)).toBe(false);
      expect(otherShare(dk, a)).toEqual(b);
      expect(otherShare(dk, b)).toEqual(a);
    }
  });
  it("rejects mismatched lengths", () => {
    expect(() => joinShares(randomBytes(32), randomBytes(31))).toThrow(KlaxonError);
  });
  it("shareHash is 64 hex", () => {
    expect(shareHash(randomBytes(32))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("AEAD", () => {
  it("round-trips with matching AAD", () => {
    const dk = generateDataKey();
    const pt = Buffer.from(`0x${"7f3a".repeat(16)}`);
    const blob = sealSecret(dk, pt, AAD);
    expect(openSecret(dk, blob, AAD)).toEqual(pt);
  });
  it("fails closed on tampered ciphertext, tag, key, and AAD", () => {
    const dk = generateDataKey();
    const blob = sealSecret(dk, Buffer.from("secret"), AAD);
    const flip = (s: string) => {
      const b = Buffer.from(s, "base64url");
      b[0] = (b[0] as number) ^ 1;
      return b.toString("base64url");
    };
    expect(() => openSecret(dk, { ...blob, ct: flip(blob.ct) }, AAD)).toThrow(/authentication/);
    expect(() => openSecret(dk, { ...blob, tag: flip(blob.tag) }, AAD)).toThrow(/authentication/);
    expect(() => openSecret(generateDataKey(), blob, AAD)).toThrow(/authentication/);
    expect(() => openSecret(dk, blob, { ...AAD, gen: "2" })).toThrow(/authentication/);
    expect(() => openSecret(dk, blob, { ...AAD, secret: "OTHER" })).toThrow(/authentication/);
  });
});

describe("ephemeral keys", () => {
  it("produces two distinct raw-32 keys and signs/verifies h", () => {
    const kp = generateEphemeral();
    expect(Buffer.from(kp.pub.sig, "base64url")).toHaveLength(32);
    expect(Buffer.from(kp.pub.enc, "base64url")).toHaveLength(32);
    expect(kp.pub.sig).not.toBe(kp.pub.enc);
    const sig = signCommitment(kp, H);
    expect(verifyCommitmentSig(kp.pub, H, sig)).toBe(true);
  });
  it("rejects wrong key, wrong h, and garbage", () => {
    const kp = generateEphemeral();
    const other = generateEphemeral();
    const sig = signCommitment(kp, H);
    expect(verifyCommitmentSig(other.pub, H, sig)).toBe(false);
    expect(verifyCommitmentSig(kp.pub, "0".repeat(64), sig)).toBe(false);
    expect(verifyCommitmentSig(kp.pub, H, "AAAA")).toBe(false);
    expect(() => signCommitment(kp, "nope")).toThrow(KlaxonError);
  });
});

describe("ECIES share delivery", () => {
  it("round-trips to the runner's enc key, bound to h", () => {
    const kp = generateEphemeral();
    const b = randomBytes(32);
    const env = eciesSeal(kp.pub.enc, H, b);
    expect(env.v).toBe(1);
    expect(eciesOpen(kp, H, env)).toEqual(b);
  });
  it("fails on wrong h, wrong recipient, and tampered envelope", () => {
    const kp = generateEphemeral();
    const other = generateEphemeral();
    const env = eciesSeal(kp.pub.enc, H, randomBytes(32));
    expect(() => eciesOpen(kp, "1".repeat(64), env)).toThrow(/authentication/);
    expect(() => eciesOpen(other, H, env)).toThrow(/authentication/);
    // Flip a real byte: changing the last base64url character can touch only padding bits.
    const ctBytes = Buffer.from(env.ct, "base64url");
    ctBytes[0] = (ctBytes[0] as number) ^ 0x01;
    const bad = { ...env, ct: ctBytes.toString("base64url") };
    expect(() => eciesOpen(kp, H, bad)).toThrow(/authentication/);
  });
  it("uses a fresh ephemeral key per seal", () => {
    const kp = generateEphemeral();
    const e1 = eciesSeal(kp.pub.enc, H, randomBytes(32));
    const e2 = eciesSeal(kp.pub.enc, H, randomBytes(32));
    expect(e1.epk).not.toBe(e2.epk);
  });
});

describe("mask registry", () => {
  it("catches leaks in hex, base64url, and base64", () => {
    clearSecretRegistry();
    const secret = randomBytes(32);
    registerSecretMaterial(secret, "plaintext-value-xyz");
    expect(() => assertNotLeaked(`log: ${secret.toString("hex")}`)).toThrow(/leaked/);
    expect(() => assertNotLeaked(`log: ${secret.toString("base64")}`)).toThrow(/leaked/);
    expect(() => assertNotLeaked("log: plaintext-value-xyz")).toThrow(/leaked/);
    expect(() => assertNotLeaked("clean log line")).not.toThrow();
    clearSecretRegistry();
  });
});
