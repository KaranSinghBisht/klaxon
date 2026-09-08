import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { sha256 } from "../canonical.js";
import { assertLength, b64u, hex, utf8 } from "../encoding.js";
import { KlaxonError } from "../errors.js";

/**
 * Operator → witness request authentication (D27). The LKRP member key is secp256k1; Node's
 * OpenSSL signs ECDSA over it natively, so no new key and no shared secret are introduced.
 *
 *   msg = sha256(utf8("klaxon-member-v1:" + METHOD + "\n" + path + "\n" + ts + "\n" + hex(sha256(body))))
 *   sig = ECDSA-secp256k1-SHA256(member_priv, msg)   (DER, base64url)
 *
 * Headers: X-Klaxon-Member-Pub (compressed hex), X-Klaxon-Ts (ISO-8601), X-Klaxon-Member-Sig.
 * The witness requires pub == project.member_pubkey and |now - ts| <= 300 s.
 */
export const MEMBER_SIG_DOMAIN = "klaxon-member-v1:";
export const MEMBER_SIG_MAX_SKEW_MS = 300_000;

// SEC1 ECPrivateKey DER for secp256k1 (OID 1.3.132.0.10) without the optional public key.
const SEC1_PREFIX = Buffer.from("302e0201010420", "hex");
const SEC1_SUFFIX = Buffer.from("a00706052b8104000a", "hex");
// SubjectPublicKeyInfo DER prefix for a compressed secp256k1 point.
const SPKI_PREFIX = Buffer.from("3036301006072a8648ce3d020106052b8104000a032200", "hex");

export function memberPrivateKey(privHex: string) {
  const raw = hex.decode(privHex);
  assertLength(raw, 32, "member private key");
  return createPrivateKey({
    key: Buffer.concat([SEC1_PREFIX, raw, SEC1_SUFFIX]),
    format: "der",
    type: "sec1",
  });
}

export function memberPublicKey(pubHex: string) {
  const raw = hex.decode(pubHex);
  assertLength(raw, 33, "member public key");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Derive the compressed public key hex from a member private key — what `export-member` uses when the keychain entry has no second line. */
export function memberPublicKeyHex(privHex: string): string {
  const pub = createPublicKey(memberPrivateKey(privHex));
  const der = pub.export({ type: "spki", format: "der" });
  // Uncompressed SPKI is 88 bytes: prefix(23) || 0x04 || X(32) || Y(32). Compress it.
  const point = der.subarray(der.length - 65);
  const x = point.subarray(1, 33);
  const yOdd = (point[64] as number) & 1;
  return Buffer.concat([Buffer.from([yOdd ? 0x03 : 0x02]), x]).toString("hex");
}

export function memberSigMessage(
  method: string,
  path: string,
  ts: string,
  body: Uint8Array,
): Buffer {
  const canon = `${MEMBER_SIG_DOMAIN}${method.toUpperCase()}\n${path}\n${ts}\n${sha256(body).toString("hex")}`;
  return sha256(utf8.encode(canon));
}

export interface MemberSignedHeaders {
  "x-klaxon-member-pub": string;
  "x-klaxon-ts": string;
  "x-klaxon-member-sig": string;
}

export function signMemberRequest(
  privHex: string,
  pubHex: string,
  method: string,
  path: string,
  body: Uint8Array,
  now: Date = new Date(),
): MemberSignedHeaders {
  const ts = now.toISOString();
  const sig = sign("sha256", memberSigMessage(method, path, ts, body), memberPrivateKey(privHex));
  return {
    "x-klaxon-member-pub": pubHex,
    "x-klaxon-ts": ts,
    "x-klaxon-member-sig": b64u.encode(sig),
  };
}

export function verifyMemberRequest(
  expectedPubHex: string,
  headers: Record<string, string | undefined>,
  method: string,
  path: string,
  body: Uint8Array,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: string } {
  const pub = headers["x-klaxon-member-pub"];
  const ts = headers["x-klaxon-ts"];
  const sig = headers["x-klaxon-member-sig"];
  if (!pub || !ts || !sig) return { ok: false, reason: "missing member auth headers" };
  if (pub !== expectedPubHex) return { ok: false, reason: "member pubkey does not match project" };
  const t = Date.parse(ts);
  if (!Number.isFinite(t) || Math.abs(now.getTime() - t) > MEMBER_SIG_MAX_SKEW_MS) {
    return { ok: false, reason: "member signature timestamp outside skew window" };
  }
  let valid = false;
  try {
    valid = verify(
      "sha256",
      memberSigMessage(method, path, ts, body),
      memberPublicKey(pub),
      b64u.decode(sig),
    );
  } catch (cause) {
    throw new KlaxonError("SIG_INVALID", "member signature could not be checked", { cause });
  }
  return valid ? { ok: true } : { ok: false, reason: "member signature invalid" };
}
