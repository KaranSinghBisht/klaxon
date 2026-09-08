import { sealSecret } from "../crypto/aead.js";
import { generateDataKey, otherShare, shareHash } from "../crypto/datakey.js";
import { registerSecretMaterial } from "../crypto/mask.js";
import { buildEncFile } from "../encfile.js";
import { shareAKeyName } from "../lkrp/constants.js";
import { ringEncrypt } from "../lkrp/domain-key.js";
import type { EncFile } from "../schema.js";

export interface AddSecretArgs {
  projectId: string;
  secret: string;
  gen: string;
  plaintext: Uint8Array;
  wsek: string;
  /** Share B, derived by the witness from its master (D28) and fetched over the member-signed channel. */
  shareB: Uint8Array;
  createdAt?: Date;
}

/**
 * Laptop-side `add` (D28): DK is fresh; the witness supplies B; A = DK ⊕ B is what gets
 * Key-Ring-encrypted into the repo. Nothing here is written to disk by this function.
 */
export function addSecret(a: AddSecretArgs): EncFile {
  const dk = generateDataKey();
  registerSecretMaterial(dk, a.plaintext, a.shareB);
  const aad = { project_id: a.projectId, secret: a.secret, gen: a.gen };
  const ct = sealSecret(dk, a.plaintext, aad);
  const shareA = otherShare(dk, a.shareB);
  registerSecretMaterial(shareA);
  const aCt = ringEncrypt(a.wsek, shareAKeyName(a.projectId, a.secret, a.gen), shareA);
  return buildEncFile({
    projectId: a.projectId,
    secret: a.secret,
    gen: a.gen,
    ct,
    aCt,
    bHash: shareHash(a.shareB),
    ...(a.createdAt ? { createdAt: a.createdAt } : {}),
  });
}
