export { KlaxonError, type KlaxonErrorCode } from "./errors.js";
export { b64u, hex, utf8, ctEqual, assertLength } from "./encoding.js";
export { canonicalize, sha256, digestHex } from "./canonical.js";
export { commitmentHash, oidcAudience, PROBE_AUDIENCE } from "./commitment.js";
export {
  CommitmentSchema,
  EncFileSchema,
  KlaxonMemberSchema,
  PolicySchema,
  EphemeralPubSchema,
  EciesEnvelopeSchema,
  AeadBlobSchema,
  type Commitment,
  type EncFile,
  type KlaxonMember,
  type Policy,
  type EphemeralPub,
  type EciesEnvelope,
  type AeadBlob,
} from "./schema.js";
export { generateDataKey, splitKey, otherShare, joinShares, shareHash, DATA_KEY_BYTES } from "./crypto/datakey.js";
export { sealSecret, openSecret, type SecretAad } from "./crypto/aead.js";
export {
  generateEphemeral,
  signCommitment,
  verifyCommitmentSig,
  rawPublicKey,
  rawPrivateKey,
  importRawPublic,
  importRawPrivate,
  SIG_DOMAIN,
  type EphemeralKeyPair,
} from "./crypto/ephemeral.js";
export { eciesSeal, eciesOpen } from "./crypto/ecies.js";
export { registerSecretMaterial, emitGithubMasks, assertNotLeaked, clearSecretRegistry } from "./crypto/mask.js";
export {
  LKRP_APPLICATION_ID,
  LKRP_SDK_NAME,
  TRUSTCHAIN_API_PROD,
  TRUSTCHAIN_API_STAGING,
  DOMAIN_KEY_SALT,
  SHARE_A_ALG,
  shareAKeyName,
} from "./lkrp/constants.js";
export { deriveDomainKey, ringEncrypt, ringDecrypt } from "./lkrp/domain-key.js";
export { encodeMember, decodeMember } from "./lkrp/member.js";
export { restoreWalletSyncKey, type RestoreOptions } from "./lkrp/restore.js";
export { buildEncFile, parseEncFile, serializeEncFile, type BuildEncFileArgs } from "./encfile.js";
export { deriveProjectId } from "./project.js";
