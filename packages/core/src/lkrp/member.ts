import { KlaxonError } from "../errors.js";
import { type KlaxonMember, KlaxonMemberSchema } from "../schema.js";
import { LKRP_APPLICATION_ID } from "./constants.js";

/**
 * `KLAXON_MEMBER` is one opaque base64 line so GitHub masks the exact value. It carries the two
 * trustchain-meta fields plus the member keypair — everything `restoreTrustchain` needs and
 * nothing the OS keychain would have to provide (the runner has no keychain).
 */
export function encodeMember(m: KlaxonMember): string {
  KlaxonMemberSchema.parse(m);
  return Buffer.from(JSON.stringify(m), "utf8").toString("base64");
}

export function decodeMember(input: string): KlaxonMember {
  const trimmed = input.trim();
  let json: unknown;
  try {
    const raw = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
    json = JSON.parse(raw);
  } catch (cause) {
    throw new KlaxonError("MEMBER_MALFORMED", "KLAXON_MEMBER is not valid JSON or base64 JSON", { cause });
  }
  const parsed = KlaxonMemberSchema.safeParse(json);
  if (!parsed.success) throw new KlaxonError("MEMBER_MALFORMED", "KLAXON_MEMBER failed schema validation");
  if (parsed.data.applicationId !== LKRP_APPLICATION_ID) {
    throw new KlaxonError("MEMBER_APP_MISMATCH", `applicationId must be ${LKRP_APPLICATION_ID}`);
  }
  return parsed.data;
}
