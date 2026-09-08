import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { assertLength, hex, utf8 } from "../encoding.js";
import { KlaxonError } from "../errors.js";
import { DOMAIN_KEY_SALT } from "./constants.js";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Byte-identical to wallet-cli's `deriveDomainKey` (D2, A §0.1):
 *   HKDF-SHA256(ikm = hexToBytes(wsek), salt = utf8("wallet-cli-domain-v1"), info = utf8(keyName), 32)
 * Verified: `crypto.hkdfSync` produces the same key as wallet-cli's `subtle.deriveBits`.
 */
export function deriveDomainKey(wsekHex: string, keyName: string): Buffer {
  const ikm = hex.decode(wsekHex);
  assertLength(ikm, 32, "walletSyncEncryptionKey");
  return Buffer.from(hkdfSync("sha256", ikm, utf8.encode(DOMAIN_KEY_SALT), utf8.encode(keyName), 32));
}

/** Byte-identical to `wallet-cli ring encrypt --key <keyName>`: iv(12) || ct || tag(16). */
export function ringEncrypt(wsekHex: string, keyName: string, plaintext: Uint8Array): Buffer {
  const key = deriveDomainKey(wsekHex, keyName);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

export function ringDecrypt(wsekHex: string, keyName: string, blob: Uint8Array): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new KlaxonError("AEAD_TAMPERED", "ring blob too short");
  const key = deriveDomainKey(wsekHex, keyName);
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (cause) {
    throw new KlaxonError("AEAD_TAMPERED", "ring blob failed authentication", { cause });
  }
}
