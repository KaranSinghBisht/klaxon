import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { assertLength, b64u, utf8 } from "../encoding.js";
import { KlaxonError } from "../errors.js";
import type { AeadBlob } from "../schema.js";

export interface SecretAad {
  project_id: string;
  secret: string;
  gen: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM with the (project, secret, gen) triple as associated data. Binding these means a
 * ciphertext physically moved to another name, project, or generation fails to open.
 */
export function sealSecret(dk: Uint8Array, plaintext: Uint8Array, aad: SecretAad): AeadBlob {
  assertLength(dk, 32, "data key");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dk, iv);
  cipher.setAAD(utf8.encode(canonicalize(aad)));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64u.encode(iv), ct: b64u.encode(ct), tag: b64u.encode(cipher.getAuthTag()) };
}

export function openSecret(dk: Uint8Array, blob: AeadBlob, aad: SecretAad): Buffer {
  assertLength(dk, 32, "data key");
  const iv = b64u.decode(blob.iv);
  const tag = b64u.decode(blob.tag);
  assertLength(iv, IV_BYTES, "iv");
  assertLength(tag, TAG_BYTES, "tag");
  const decipher = createDecipheriv("aes-256-gcm", dk, iv);
  decipher.setAAD(utf8.encode(canonicalize(aad)));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(b64u.decode(blob.ct)), decipher.final()]);
  } catch (cause) {
    throw new KlaxonError("AEAD_TAMPERED", "secret ciphertext failed authentication", { cause });
  }
}
