import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { sha256 } from "../canonical.js";
import { assertLength, b64u, hex, utf8 } from "../encoding.js";
import { KlaxonError } from "../errors.js";

/**
 * Operator → witness request authentication.
 *
 * This used to be signed with the LKRP **member** key (D27). It is not any more, and the reason
 * matters: the member credential is a required input of `klaxon/get`, so it sits in the
 * environment of every protected job. Anything sharing that environment — a worm in an npm
 * `postinstall`, say — could therefore sign `POST /shares` and be handed share B directly, with
 * no payment, no commitment and no HCS record. The admin surface now takes a separate operator
 * key that is generated at `klaxon init` and never leaves the laptop.
 *
 *   msg = sha256(utf8("klaxon-operator-v1:" + METHOD + "\n" + path + "\n" + ts + "\n" + hex(sha256(body))))
 *   sig = ECDSA-secp256k1-SHA256(operator_priv, msg)   (DER, base64url)
 *
 * Headers: X-Klaxon-Operator-Pub (compressed hex), X-Klaxon-Ts (ISO-8601), X-Klaxon-Operator-Sig.
 * The witness requires pub == project.operator_pubkey and |now - ts| <= 300 s. The domain string
 * differs from the commitment's, so neither signature can ever be replayed as the other.
 */
export const OPERATOR_SIG_DOMAIN = "klaxon-operator-v1:";
export const OPERATOR_SIG_MAX_SKEW_MS = 300_000;

// SEC1 ECPrivateKey DER for secp256k1 (OID 1.3.132.0.10) without the optional public key.
const SEC1_PREFIX = Buffer.from("302e0201010420", "hex");
const SEC1_SUFFIX = Buffer.from("a00706052b8104000a", "hex");
// SubjectPublicKeyInfo DER prefix for a compressed secp256k1 point.
const SPKI_PREFIX = Buffer.from("3036301006072a8648ce3d020106052b8104000a032200", "hex");

/** secp256k1 is the curve for both the LKRP member key and the operator key, so this is shared. */
export function secpPrivateKey(privHex: string) {
  const raw = hex.decode(privHex);
  assertLength(raw, 32, "secp256k1 private key");
  return createPrivateKey({
    key: Buffer.concat([SEC1_PREFIX, raw, SEC1_SUFFIX]),
    format: "der",
    type: "sec1",
  });
}

export function secpPublicKey(pubHex: string) {
  const raw = hex.decode(pubHex);
  assertLength(raw, 33, "secp256k1 public key");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/**
 * Compressed public key hex from a private key. `export-member` uses it when the keychain entry
 * carries no second line, and `klaxon init` uses it to derive the operator pubkey it registers.
 */
export function compressedPubkeyHex(privHex: string): string {
  const pub = createPublicKey(secpPrivateKey(privHex));
  const der = pub.export({ type: "spki", format: "der" });
  // Uncompressed SPKI is 88 bytes: prefix(23) || 0x04 || X(32) || Y(32). Compress it.
  const point = der.subarray(der.length - 65);
  const x = point.subarray(1, 33);
  const yOdd = (point[64] as number) & 1;
  return Buffer.concat([Buffer.from([yOdd ? 0x03 : 0x02]), x]).toString("hex");
}

export interface OperatorKey {
  privatekey: string;
  pubkey: string;
}

/**
 * A fresh operator keypair. Rejection sampling keeps the scalar in [1, n): the odds of needing a
 * second draw are about 2^-128, but a silently out-of-range key would fail much later and much
 * more confusingly than a loop that costs nothing.
 */
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

export function generateOperatorKey(): OperatorKey {
  for (;;) {
    const raw = randomBytes(32);
    const d = BigInt(`0x${raw.toString("hex")}`);
    if (d === 0n || d >= SECP256K1_N) continue;
    const privatekey = raw.toString("hex");
    return { privatekey, pubkey: compressedPubkeyHex(privatekey) };
  }
}

export function operatorSigMessage(
  method: string,
  path: string,
  ts: string,
  body: Uint8Array,
): Buffer {
  const canon = `${OPERATOR_SIG_DOMAIN}${method.toUpperCase()}\n${path}\n${ts}\n${sha256(body).toString("hex")}`;
  return sha256(utf8.encode(canon));
}

export interface OperatorSignedHeaders {
  "x-klaxon-operator-pub": string;
  "x-klaxon-ts": string;
  "x-klaxon-operator-sig": string;
}

export function signOperatorRequest(
  privHex: string,
  pubHex: string,
  method: string,
  path: string,
  body: Uint8Array,
  now: Date = new Date(),
): OperatorSignedHeaders {
  const ts = now.toISOString();
  const sig = sign("sha256", operatorSigMessage(method, path, ts, body), secpPrivateKey(privHex));
  return {
    "x-klaxon-operator-pub": pubHex,
    "x-klaxon-ts": ts,
    "x-klaxon-operator-sig": b64u.encode(sig),
  };
}

export function verifyOperatorRequest(
  expectedPubHex: string,
  headers: Record<string, string | undefined>,
  method: string,
  path: string,
  body: Uint8Array,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: string } {
  const pub = headers["x-klaxon-operator-pub"];
  const ts = headers["x-klaxon-ts"];
  const sig = headers["x-klaxon-operator-sig"];
  if (!pub || !ts || !sig) return { ok: false, reason: "missing operator auth headers" };
  if (pub !== expectedPubHex) {
    return { ok: false, reason: "operator pubkey does not match project" };
  }
  const t = Date.parse(ts);
  if (!Number.isFinite(t) || Math.abs(now.getTime() - t) > OPERATOR_SIG_MAX_SKEW_MS) {
    return { ok: false, reason: "operator signature timestamp outside skew window" };
  }
  let valid = false;
  try {
    valid = verify(
      "sha256",
      operatorSigMessage(method, path, ts, body),
      secpPublicKey(pub),
      b64u.decode(sig),
    );
  } catch (cause) {
    throw new KlaxonError("SIG_INVALID", "operator signature could not be checked", { cause });
  }
  return valid ? { ok: true } : { ok: false, reason: "operator signature invalid" };
}
