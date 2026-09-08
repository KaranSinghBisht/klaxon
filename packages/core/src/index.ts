export { canonicalize, digestHex, sha256 } from "./canonical.js";
export { commitmentHash, oidcAudience, PROBE_AUDIENCE } from "./commitment.js";
export { openSecret, type SecretAad, sealSecret } from "./crypto/aead.js";
export {
  DATA_KEY_BYTES,
  generateDataKey,
  joinShares,
  otherShare,
  shareHash,
  splitKey,
} from "./crypto/datakey.js";
export { eciesOpen, eciesSeal } from "./crypto/ecies.js";
export {
  type EphemeralKeyPair,
  generateEphemeral,
  importRawPrivate,
  importRawPublic,
  rawPrivateKey,
  rawPublicKey,
  SIG_DOMAIN,
  signCommitment,
  verifyCommitmentSig,
} from "./crypto/ephemeral.js";
export {
  assertNotLeaked,
  clearSecretRegistry,
  emitGithubMasks,
  registerSecretMaterial,
} from "./crypto/mask.js";
export { type BuildEncFileArgs, buildEncFile, parseEncFile, serializeEncFile } from "./encfile.js";
export { assertLength, b64u, ctEqual, hex, utf8 } from "./encoding.js";
export { KlaxonError, type KlaxonErrorCode } from "./errors.js";
export {
  DOMAIN_KEY_SALT,
  LKRP_APPLICATION_ID,
  LKRP_SDK_NAME,
  SHARE_A_ALG,
  shareAKeyName,
  TRUSTCHAIN_API_PROD,
  TRUSTCHAIN_API_STAGING,
} from "./lkrp/constants.js";
export { deriveDomainKey, ringDecrypt, ringEncrypt } from "./lkrp/domain-key.js";
export { decodeMember, encodeMember } from "./lkrp/member.js";
export {
  MEMBER_SIG_DOMAIN,
  MEMBER_SIG_MAX_SKEW_MS,
  type MemberSignedHeaders,
  memberPublicKeyHex,
  memberSigMessage,
  signMemberRequest,
  verifyMemberRequest,
} from "./lkrp/member-sign.js";
export { type RestoreOptions, restoreWalletSyncKey } from "./lkrp/restore.js";
export { deriveProjectId } from "./project.js";
export { type AddSecretArgs, addSecret } from "./release/add.js";
export {
  decodeJwtClaims,
  type GetSecretOptions,
  type GetSecretResult,
  getSecret,
  NO_ENVIRONMENT,
} from "./release/get.js";
export type {
  OidcProvider,
  ReleaseOk,
  ReleaseRefused,
  ReleaseRequestBody,
  ReleaseResponse,
  ReleaseTransport,
  WsekRestorer,
} from "./release/ports.js";
export {
  type AeadBlob,
  AeadBlobSchema,
  type Commitment,
  CommitmentSchema,
  type EciesEnvelope,
  EciesEnvelopeSchema,
  type EncFile,
  EncFileSchema,
  type EphemeralPub,
  EphemeralPubSchema,
  type KlaxonMember,
  KlaxonMemberSchema,
  type Policy,
  PolicySchema,
} from "./schema.js";
