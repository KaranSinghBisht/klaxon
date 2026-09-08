import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { assertLength, b64u, utf8 } from "../encoding.js";
import { KlaxonError } from "../errors.js";
import type { EphemeralPub } from "../schema.js";

/**
 * Two ephemeral keys per release (D1): ed25519 signs the commitment hash, x25519 receives share B.
 * One key must never do both. Both are Node built-ins — no native or WASM dependency on the runner.
 */
export interface EphemeralKeyPair {
  pub: EphemeralPub;
  sigPriv: KeyObject;
  encPriv: KeyObject;
}

/** Domain separation: the 64-byte signature can never be replayed as a signature over another protocol's value. */
export const SIG_DOMAIN = "klaxon-release-v1:";

// SubjectPublicKeyInfo DER prefixes for raw 32-byte keys (RFC 8410).
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
// PKCS#8 DER prefixes for raw 32-byte private keys.
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

export function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

export function rawPrivateKey(key: KeyObject): Buffer {
  const der = key.export({ type: "pkcs8", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

export function importRawPublic(kind: "ed25519" | "x25519", raw: Uint8Array): KeyObject {
  assertLength(raw, 32, `${kind} public key`);
  const prefix = kind === "ed25519" ? SPKI_ED25519 : SPKI_X25519;
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

export function importRawPrivate(kind: "ed25519" | "x25519", raw: Uint8Array): KeyObject {
  assertLength(raw, 32, `${kind} private key`);
  const prefix = kind === "ed25519" ? PKCS8_ED25519 : PKCS8_X25519;
  return createPrivateKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "pkcs8" });
}

export function generateEphemeral(): EphemeralKeyPair {
  const sig = generateKeyPairSync("ed25519");
  const enc = generateKeyPairSync("x25519");
  return {
    pub: {
      sig: b64u.encode(rawPublicKey(sig.publicKey)),
      enc: b64u.encode(rawPublicKey(enc.publicKey)),
    },
    sigPriv: sig.privateKey,
    encPriv: enc.privateKey,
  };
}

function sigMessage(hHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hHex)) throw new KlaxonError("SIG_INVALID", "h must be 64 hex chars");
  return utf8.encode(SIG_DOMAIN + hHex);
}

/** Ed25519 over utf8("klaxon-release-v1:" + h). Returns base64url of the 64-byte signature. */
export function signCommitment(kp: EphemeralKeyPair, hHex: string): string {
  return b64u.encode(sign(null, sigMessage(hHex), kp.sigPriv));
}

export function verifyCommitmentSig(pub: EphemeralPub, hHex: string, sigB64u: string): boolean {
  const signature = b64u.decode(sigB64u);
  if (signature.length !== 64) return false;
  let key: KeyObject;
  try {
    key = importRawPublic("ed25519", b64u.decode(pub.sig));
  } catch {
    return false;
  }
  return verify(null, sigMessage(hHex), key, signature);
}
