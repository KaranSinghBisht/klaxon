import { z } from "zod";

/**
 * The verifier's own copy of every shape it reads off the public record (D5). These duplicate
 * `@klaxon/core` on purpose: if the witness could relax a schema and have the auditor relax with
 * it, the audit would be worthless.
 */

export const HEX64 = /^[0-9a-f]{64}$/;
export const B64U = /^[A-Za-z0-9_-]+$/;
export const DIGITS = /^[0-9]+$/;
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export const EphemeralPubSchema = z.object({
  sig: z.string().regex(B64U).length(43),
  enc: z.string().regex(B64U).length(43),
});

/** PROTOCOL §1 — all numerics are strings (D17). */
export const CommitmentSchema = z
  .object({
    v: z.literal(1),
    project_id: z.string().regex(HEX64),
    secret: z.string().regex(SECRET_NAME),
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

const EnvPolicySchema = z
  .object({
    secrets: z.array(z.string().regex(SECRET_NAME)).min(1),
    max_releases: z.number().int().positive().optional(),
  })
  .strict();

/** PROTOCOL §6 check 4 — hashed as the exact committed bytes, anchored on Sepolia. */
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

export const ENVELOPE_TYPES = [
  "released",
  "refused",
  "rotate",
  "revoke",
  "unrevoke",
  "jwks",
  "emergency",
] as const;
export type EnvelopeType = (typeof ENVELOPE_TYPES)[number];

/**
 * PROTOCOL §7. Loose on purpose: the envelope is frozen (D35) but a future witness may add
 * fields, and an auditor that refused to read a record it half-understands would be easy to
 * blind by appending a key.
 */
export const EnvelopeSchema = z.looseObject({
  klaxon: z.literal(1),
  type: z.enum(ENVELOPE_TYPES),
  ts: z.string().min(1),
  project_id: z.string().regex(HEX64),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const ReleaseBodySchema = z.looseObject({
  h: z.string().regex(HEX64),
  C: z.unknown(),
  jwt: z.string().min(1),
  sig: z.string().regex(B64U),
  pay_tx: z.string().min(1),
});

export const RefusedBodySchema = z.looseObject({
  class: z.string().min(1),
  check: z.number().int(),
  reason: z.string(),
});

export const RevokeBodySchema = z.looseObject({
  reason: z.string(),
  epoch: z.union([z.number().int().nonnegative(), z.string().regex(DIGITS)]),
});

export const UnrevokeBodySchema = z.looseObject({
  epoch: z.union([z.number().int().nonnegative(), z.string().regex(DIGITS)]),
});

/** A daily snapshot of GitHub's JWKS, published so old tokens stay checkable (B §5.6). */
export const JwksBodySchema = z.looseObject({
  keys: z.array(z.record(z.string(), z.unknown())).min(1),
});

export const RotateBodySchema = z.looseObject({
  secret: z.string().regex(SECRET_NAME),
  from_gen: z.string().regex(DIGITS),
  to_gen: z.string().regex(DIGITS),
});
