import { z } from "zod";

export const HEX64 = /^[0-9a-f]{64}$/;
export const B64U = /^[A-Za-z0-9_-]+$/;
export const DIGITS = /^[0-9]+$/;

/** Ephemeral public keys: ed25519 for signing, x25519 for key agreement (D1). Raw 32 bytes, base64url. */
export const EphemeralPubSchema = z.object({
  sig: z.string().regex(B64U).length(43),
  enc: z.string().regex(B64U).length(43),
});
export type EphemeralPub = z.infer<typeof EphemeralPubSchema>;

/**
 * The release commitment. Every GitHub-derived field is a string (D17) and is cross-checked by
 * the witness against the OIDC token's own claims — `aud` alone binds nothing (A §0.5).
 */
export const CommitmentSchema = z
  .object({
    v: z.literal(1),
    project_id: z.string().regex(HEX64),
    secret: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    gen: z.string().regex(DIGITS),
    repository_id: z.string().regex(DIGITS),
    run_id: z.string().regex(DIGITS),
    run_attempt: z.string().regex(DIGITS),
    environment: z.string().min(1).max(255),
    ephemeral_pub: EphemeralPubSchema,
    ts: z.iso.datetime(),
  })
  .strict();
export type Commitment = z.infer<typeof CommitmentSchema>;

export const AeadBlobSchema = z
  .object({
    iv: z.string().regex(B64U).length(16),
    ct: z.string().regex(B64U),
    tag: z.string().regex(B64U).length(22),
  })
  .strict();
export type AeadBlob = z.infer<typeof AeadBlobSchema>;

/** `.klaxon/<NAME>.enc` — committed to git, generation-scoped, self-verifying via AAD (A §2.9). */
export const EncFileSchema = z
  .object({
    klaxon: z.literal(1),
    project_id: z.string().regex(HEX64),
    secret: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    gen: z.string().regex(DIGITS),
    alg: z
      .object({
        aead: z.literal("AES-256-GCM"),
        split: z.literal("xor-2of2"),
        share_a: z.literal("lkrp-wallet-cli-domain-v1"),
        application_id: z.literal(17),
      })
      .strict(),
    ct: AeadBlobSchema,
    a_ct: z.string().regex(B64U),
    a_key_name: z.string().regex(/^klaxon\/[0-9a-f]{64}\/[A-Z][A-Z0-9_]{0,127}\/[0-9]+$/),
    b_hash: z.string().regex(HEX64),
    created_at: z.iso.datetime(),
  })
  .strict();
export type EncFile = z.infer<typeof EncFileSchema>;

/** The `KLAXON_MEMBER` credential (D3: plaintext by default, printed once by `export-member`). */
export const KlaxonMemberSchema = z
  .object({
    v: z.literal(1),
    rootId: z.string().min(1),
    applicationPath: z.string().min(1),
    applicationId: z.literal(17),
    privatekey: z.string().regex(/^[0-9a-f]{64}$/),
    pubkey: z.string().regex(/^0[23][0-9a-f]{64}$/),
  })
  .strict();
export type KlaxonMember = z.infer<typeof KlaxonMemberSchema>;

export const EciesEnvelopeSchema = z
  .object({
    v: z.literal(1),
    epk: z.string().regex(B64U).length(43),
    ct: z.string().regex(B64U),
    tag: z.string().regex(B64U).length(22),
  })
  .strict();
export type EciesEnvelope = z.infer<typeof EciesEnvelopeSchema>;

const EnvPolicySchema = z
  .object({
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)).min(1),
    max_releases: z.number().int().positive().optional(),
  })
  .strict();

/** `klaxon.policy.json` — hashed as exact committed bytes and anchored on Sepolia (A §4.3). */
export const PolicySchema = z
  .object({
    klaxon: z.literal(1),
    project_id: z.string().regex(HEX64),
    repository_id: z.string().regex(DIGITS),
    max_releases: z.number().int().positive().default(50),
    environments: z.record(z.string().min(1), EnvPolicySchema),
    workflow_rules: z
      .object({
        forbid_install_steps: z.boolean().default(true),
        require_pinned_uses: z.boolean().default(true),
      })
      .strict()
      .default({ forbid_install_steps: true, require_pinned_uses: true }),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;
