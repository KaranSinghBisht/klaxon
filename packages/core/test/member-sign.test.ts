import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  memberPublicKeyHex,
  signMemberRequest,
  verifyMemberRequest,
} from "../src/lkrp/member-sign.js";

// A real secp256k1 keypair the way LKRP would hold it: 32-byte private, 33-byte compressed public.
const ecdh = createECDH("secp256k1");
ecdh.generateKeys();
const priv = ecdh.getPrivateKey("hex").padStart(64, "0");
const pub = ecdh.getPublicKey("hex", "compressed");

describe("member request signing", () => {
  const body = Buffer.from(JSON.stringify({ project_id: "p", secret: "X", gen: "1" }));

  it("derives the same compressed pubkey ECDH does", () => {
    expect(memberPublicKeyHex(priv)).toBe(pub);
  });

  it("signs and verifies a request", () => {
    const h = signMemberRequest(priv, pub, "post", "/shares", body);
    expect(verifyMemberRequest(pub, h, "POST", "/shares", body)).toEqual({ ok: true });
  });

  it("rejects wrong path, method, body, pubkey, and stale timestamps", () => {
    const h = signMemberRequest(priv, pub, "POST", "/shares", body);
    expect(verifyMemberRequest(pub, h, "POST", "/revoke", body).ok).toBe(false);
    expect(verifyMemberRequest(pub, h, "GET", "/shares", body).ok).toBe(false);
    expect(verifyMemberRequest(pub, h, "POST", "/shares", Buffer.from("{}")).ok).toBe(false);
    const other = createECDH("secp256k1");
    other.generateKeys();
    expect(
      verifyMemberRequest(other.getPublicKey("hex", "compressed"), h, "POST", "/shares", body).ok,
    ).toBe(false);
    const old = signMemberRequest(
      priv,
      pub,
      "POST",
      "/shares",
      body,
      new Date(Date.now() - 10 * 60_000),
    );
    expect(verifyMemberRequest(pub, old, "POST", "/shares", body).ok).toBe(false);
  });
});
