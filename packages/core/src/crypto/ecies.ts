import {
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from "node:crypto";
import { b64u, utf8 } from "../encoding.js";
import { KlaxonError } from "../errors.js";
import type { EciesEnvelope } from "../schema.js";
import { type EphemeralKeyPair, importRawPublic, rawPublicKey } from "./ephemeral.js";

/**
 * Share B delivery (D24):
 *   (e_priv, e_pub) = X25519 keygen, fresh per message
 *   ss   = X25519(e_priv, R)
 *   salt = e_pub || R                      binds both public keys
 *   info = "klaxon/ecies/v1|" + h          binds this commitment
 *   okm  = HKDF-SHA256(ss, salt, info, 44) → key(32) || iv(12)
 *   ct||tag = AES-256-GCM(key, iv, aad = utf8(h), message)
 * The IV is derived, not random: safe because e_priv is fresh per message so okm is fresh.
 * An envelope minted for one release cannot be spliced into another.
 */
const INFO_PREFIX = "klaxon/ecies/v1|";

function assertH(hHex: string): void {
  if (!/^[0-9a-f]{64}$/.test(hHex))
    throw new KlaxonError("ECIES_BAD_ENVELOPE", "h must be 64 hex chars");
}

function deriveKeyIv(ss: Uint8Array, salt: Uint8Array, hHex: string): { key: Buffer; iv: Buffer } {
  const okm = Buffer.from(hkdfSync("sha256", ss, salt, utf8.encode(INFO_PREFIX + hHex), 44));
  return { key: okm.subarray(0, 32), iv: okm.subarray(32, 44) };
}

/** Witness side: encrypt share B to the runner's ephemeral X25519 key, bound to h. */
export function eciesSeal(
  recipientEncPubB64u: string,
  hHex: string,
  message: Uint8Array,
): EciesEnvelope {
  assertH(hHex);
  const rPub = importRawPublic("x25519", b64u.decode(recipientEncPubB64u));
  const e = generateKeyPairSync("x25519");
  const ss = diffieHellman({ privateKey: e.privateKey, publicKey: rPub });
  const ePubRaw = rawPublicKey(e.publicKey);
  const rPubRaw = rawPublicKey(rPub);
  const { key, iv } = deriveKeyIv(ss, Buffer.concat([ePubRaw, rPubRaw]), hHex);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(utf8.encode(hHex));
  const ct = Buffer.concat([cipher.update(message), cipher.final()]);
  return {
    v: 1,
    epk: b64u.encode(ePubRaw),
    ct: b64u.encode(ct),
    tag: b64u.encode(cipher.getAuthTag()),
  };
}

/** Runner side: open with the ephemeral X25519 private key. Wrong h or wrong key → throws. */
export function eciesOpen(kp: EphemeralKeyPair, hHex: string, env: EciesEnvelope): Buffer {
  assertH(hHex);
  if (env.v !== 1) throw new KlaxonError("ECIES_BAD_ENVELOPE", "unsupported envelope version");
  const ePubRaw = b64u.decode(env.epk);
  const ePub = importRawPublic("x25519", ePubRaw);
  const ss = diffieHellman({ privateKey: kp.encPriv, publicKey: ePub });
  const rPubRaw = b64u.decode(kp.pub.enc);
  const { key, iv } = deriveKeyIv(ss, Buffer.concat([ePubRaw, rPubRaw]), hHex);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(utf8.encode(hHex));
  decipher.setAuthTag(b64u.decode(env.tag));
  try {
    return Buffer.concat([decipher.update(b64u.decode(env.ct)), decipher.final()]);
  } catch (cause) {
    throw new KlaxonError("ECIES_TAMPERED", "share envelope failed authentication", { cause });
  }
}
