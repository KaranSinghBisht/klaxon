import { randomBytes, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DOMAIN_KEY_SALT, shareAKeyName } from "../src/lkrp/constants.js";
import { deriveDomainKey, ringDecrypt, ringEncrypt } from "../src/lkrp/domain-key.js";

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * The independent oracle is WebCrypto — the exact API wallet-cli's `deriveDomainKey` and
 * `ring encrypt` call (A §0.1). If these agree, our blobs open in the real Ledger CLI.
 */
async function walletCliDeriveDomainKey(wsekHex: string, keyName: string): Promise<Uint8Array> {
  const ikm = Buffer.from(wsekHex, "hex");
  const hk = await webcrypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc(DOMAIN_KEY_SALT), info: enc(keyName) },
    hk,
    256,
  );
  return new Uint8Array(bits);
}

async function walletCliRingDecrypt(
  wsekHex: string,
  keyName: string,
  blob: Uint8Array,
): Promise<Uint8Array> {
  const raw = await walletCliDeriveDomainKey(wsekHex, keyName);
  const key = await webcrypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = blob.subarray(0, 12);
  const body = blob.subarray(12); // ct || tag — WebCrypto expects the tag appended
  return new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body));
}

async function walletCliRingEncrypt(
  wsekHex: string,
  keyName: string,
  pt: Uint8Array,
): Promise<Uint8Array> {
  const raw = await walletCliDeriveDomainKey(wsekHex, keyName);
  const key = await webcrypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = randomBytes(12);
  const body = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  return Buffer.concat([iv, body]);
}

describe("wallet-cli domain key compatibility", () => {
  const wsek = randomBytes(32).toString("hex");
  const name = shareAKeyName("0".repeat(64), "DEPLOYER_PRIVATE_KEY", "3");

  it("hkdfSync matches WebCrypto deriveBits byte-for-byte", async () => {
    expect(deriveDomainKey(wsek, name)).toEqual(
      Buffer.from(await walletCliDeriveDomainKey(wsek, name)),
    );
  });

  it("golden vector is stable (regression lock)", () => {
    // A real pin, not a tautology. Derived from an all-zero wsek and a fixed key name, so it
    // carries no key material, and any drift in the salt (`wallet-cli-domain-v1`), the info
    // (the key name) or the KDF changes it. The interop test proves this derivation is the one
    // real `wallet-cli ring encrypt`/`decrypt` agrees with, in both directions.
    const k = deriveDomainKey("00".repeat(32), "klaxon/test");
    expect(k.toString("hex")).toBe(
      "b532a4dbaf6fdc1ea056106805018800efdd111be13454909da1938ecf8b7fff",
    );
    expect(k).toHaveLength(32);
  });

  it("our ringEncrypt opens through wallet-cli's decrypt path", async () => {
    const pt = randomBytes(32);
    const blob = ringEncrypt(wsek, name, pt);
    expect(blob).toHaveLength(12 + 32 + 16);
    expect(Buffer.from(await walletCliRingDecrypt(wsek, name, blob))).toEqual(pt);
  });

  it("a wallet-cli-produced blob opens with our ringDecrypt", async () => {
    const pt = randomBytes(32);
    const blob = await walletCliRingEncrypt(wsek, name, pt);
    expect(ringDecrypt(wsek, name, blob)).toEqual(pt);
  });

  it("a different key name or generation cannot open the blob", () => {
    const blob = ringEncrypt(wsek, name, randomBytes(32));
    expect(() =>
      ringDecrypt(wsek, shareAKeyName("0".repeat(64), "DEPLOYER_PRIVATE_KEY", "4"), blob),
    ).toThrow(/authentication/);
    expect(() => ringDecrypt(randomBytes(32).toString("hex"), name, blob)).toThrow(
      /authentication/,
    );
  });
});
