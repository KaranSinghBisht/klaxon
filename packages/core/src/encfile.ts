import { b64u } from "./encoding.js";
import { KlaxonError } from "./errors.js";
import { LKRP_APPLICATION_ID, shareAKeyName } from "./lkrp/constants.js";
import { type AeadBlob, type EncFile, EncFileSchema } from "./schema.js";

export interface BuildEncFileArgs {
  projectId: string;
  secret: string;
  gen: string;
  ct: AeadBlob;
  aCt: Uint8Array;
  bHash: string;
  createdAt?: Date;
}

export function buildEncFile(a: BuildEncFileArgs): EncFile {
  const file: EncFile = {
    klaxon: 1,
    project_id: a.projectId,
    secret: a.secret,
    gen: a.gen,
    alg: {
      aead: "AES-256-GCM",
      split: "xor-2of2",
      share_a: "lkrp-wallet-cli-domain-v1",
      application_id: LKRP_APPLICATION_ID,
    },
    ct: a.ct,
    a_ct: b64u.encode(a.aCt),
    a_key_name: shareAKeyName(a.projectId, a.secret, a.gen),
    b_hash: a.bHash,
    created_at: (a.createdAt ?? new Date()).toISOString(),
  };
  return EncFileSchema.parse(file);
}

export function parseEncFile(json: unknown): EncFile {
  const parsed = EncFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new KlaxonError("ENC_MALFORMED", `.enc failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  const f = parsed.data;
  if (f.a_key_name !== shareAKeyName(f.project_id, f.secret, f.gen)) {
    throw new KlaxonError("ENC_MALFORMED", ".enc a_key_name does not match its project/secret/gen");
  }
  return f;
}

export function serializeEncFile(f: EncFile): string {
  return `${JSON.stringify(f, null, 2)}\n`;
}
