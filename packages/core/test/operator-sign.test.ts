import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compressedPubkeyHex,
  generateOperatorKey,
  signOperatorRequest,
  verifyOperatorRequest,
} from "../src/auth/operator-sign.js";

// A real secp256k1 keypair: 32-byte private, 33-byte compressed public.
const ecdh = createECDH("secp256k1");
ecdh.generateKeys();
const priv = ecdh.getPrivateKey("hex").padStart(64, "0");
const pub = ecdh.getPublicKey("hex", "compressed");

describe("operator request signing", () => {
  const body = Buffer.from(JSON.stringify({ project_id: "p", secret: "X", gen: "1" }));

  it("derives the same compressed pubkey ECDH does", () => {
    expect(compressedPubkeyHex(priv)).toBe(pub);
  });

  it("generates a usable keypair", () => {
    const k = generateOperatorKey();
    expect(k.privatekey).toMatch(/^[0-9a-f]{64}$/);
    expect(k.pubkey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(compressedPubkeyHex(k.privatekey)).toBe(k.pubkey);
    expect(generateOperatorKey().privatekey).not.toBe(k.privatekey);
  });

  it("signs and verifies a request", () => {
    const h = signOperatorRequest(priv, pub, "post", "/shares", body);
    expect(verifyOperatorRequest(pub, h, "POST", "/shares", body)).toEqual({ ok: true });
  });

  it("rejects wrong path, method, body, pubkey, and stale timestamps", () => {
    const h = signOperatorRequest(priv, pub, "POST", "/shares", body);
    expect(verifyOperatorRequest(pub, h, "POST", "/revoke", body).ok).toBe(false);
    expect(verifyOperatorRequest(pub, h, "GET", "/shares", body).ok).toBe(false);
    expect(verifyOperatorRequest(pub, h, "POST", "/shares", Buffer.from("{}")).ok).toBe(false);
    const other = createECDH("secp256k1");
    other.generateKeys();
    expect(
      verifyOperatorRequest(other.getPublicKey("hex", "compressed"), h, "POST", "/shares", body).ok,
    ).toBe(false);
    const old = signOperatorRequest(
      priv,
      pub,
      "POST",
      "/shares",
      body,
      new Date(Date.now() - 10 * 60_000),
    );
    expect(verifyOperatorRequest(pub, old, "POST", "/shares", body).ok).toBe(false);
  });

  it("refuses headers that carry no operator signature at all", () => {
    expect(verifyOperatorRequest(pub, {}, "POST", "/shares", body)).toEqual({
      ok: false,
      reason: "missing operator auth headers",
    });
  });

  /**
   * The whole point of the split: the credential the runner holds signs under a different domain
   * and different header names, so a member-signed request can never authorise an admin route.
   */
  it("does not accept a signature made under the member domain", () => {
    const h = signOperatorRequest(priv, pub, "POST", "/shares", body);
    const memberShaped = {
      "x-klaxon-member-pub": h["x-klaxon-operator-pub"],
      "x-klaxon-ts": h["x-klaxon-ts"],
      "x-klaxon-member-sig": h["x-klaxon-operator-sig"],
    };
    expect(verifyOperatorRequest(pub, memberShaped, "POST", "/shares", body).ok).toBe(false);
  });
});
