import { commitmentHash, oidcAudience, PROBE_AUDIENCE } from "../commitment.js";
import { openSecret } from "../crypto/aead.js";
import { joinShares, shareHash } from "../crypto/datakey.js";
import { eciesOpen } from "../crypto/ecies.js";
import { generateEphemeral, signCommitment } from "../crypto/ephemeral.js";
import { registerSecretMaterial } from "../crypto/mask.js";
import { b64u, ctEqual } from "../encoding.js";
import { KlaxonError } from "../errors.js";
import { ringDecrypt } from "../lkrp/domain-key.js";
import { type Commitment, CommitmentSchema, type EncFile, type KlaxonMember } from "../schema.js";
import type { OidcProvider, ReleaseTransport, WsekRestorer } from "./ports.js";

export interface GetSecretOptions {
  enc: EncFile;
  member: KlaxonMember;
  oidc: OidcProvider;
  transport: ReleaseTransport;
  restore: WsekRestorer;
  clock?: () => Date;
}

export interface GetSecretResult {
  secret: Buffer;
  h: string;
  payTx: string;
  hcs: { sequence_number: string; consensus_timestamp: string };
  timings: { restoreMs: number; releaseMs: number };
}

/** Sentinel written into `C.environment` when the probe token carries no environment claim — the refusal must still be paid for and recorded. */
export const NO_ENVIRONMENT = "(none)";

interface ProbeClaims {
  repository_id: string;
  run_id: string;
  run_attempt: string;
  environment: string;
}

/** Reads claims from a JWT without verifying it — the witness verifies; the client only needs the values to build C (D18). */
export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) throw new KlaxonError("MEMBER_MALFORMED", "malformed JWT");
  return JSON.parse(b64u.decode(parts[1]).toString("utf8")) as Record<string, unknown>;
}

function probeClaims(claims: Record<string, unknown>): ProbeClaims {
  const str = (k: string): string => {
    const v = claims[k];
    return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  };
  const out = {
    repository_id: str("repository_id"),
    run_id: str("run_id"),
    run_attempt: str("run_attempt"),
    environment: str("environment") || NO_ENVIRONMENT,
  };
  if (!out.repository_id || !out.run_id || !out.run_attempt) {
    throw new KlaxonError("MEMBER_MALFORMED", "probe token lacks repository_id/run_id/run_attempt");
  }
  return out;
}

/**
 * The runner-side release sequence (A §4.2 with D18). Ordering is load-bearing:
 * A is decrypted first so a failed release never leaves a paid commitment without a usable A;
 * the JWT is minted after h and spent seconds later; B is verified against b_hash before use.
 */
export async function getSecret(o: GetSecretOptions): Promise<GetSecretResult> {
  const now = o.clock ?? (() => new Date());
  const t0 = Date.now();

  const wsek = await o.restore(o.member);
  const restoreMs = Date.now() - t0;
  const a = ringDecrypt(wsek, o.enc.a_key_name, b64u.decode(o.enc.a_ct));
  registerSecretMaterial(a);

  const ek = generateEphemeral();
  const probe = probeClaims(decodeJwtClaims(await o.oidc(PROBE_AUDIENCE)));
  const C: Commitment = CommitmentSchema.parse({
    v: 1,
    project_id: o.enc.project_id,
    secret: o.enc.secret,
    gen: o.enc.gen,
    repository_id: probe.repository_id,
    run_id: probe.run_id,
    run_attempt: probe.run_attempt,
    environment: probe.environment,
    ephemeral_pub: ek.pub,
    ts: now().toISOString(),
  });
  const h = commitmentHash(C);
  const jwt = await o.oidc(oidcAudience(h));
  const sig = signCommitment(ek, h);

  const t1 = Date.now();
  const res = await o.transport.release(h, { C, jwt, sig });
  const releaseMs = Date.now() - t1;

  if (!res.body.ok) {
    throw new KlaxonError(
      "WITNESS_BAD_SHARE",
      `release refused (${res.body.class}, check ${res.body.check}): ${res.body.reason} [h=${h}]`,
    );
  }
  if (res.body.h !== h)
    throw new KlaxonError("WITNESS_BAD_SHARE", "witness answered for a different commitment");

  const bShare = eciesOpen(ek, h, res.body.share_b);
  registerSecretMaterial(bShare);
  if (!ctEqual(Buffer.from(shareHash(bShare), "hex"), Buffer.from(o.enc.b_hash, "hex"))) {
    throw new KlaxonError(
      "WITNESS_BAD_SHARE",
      "witness returned a share that does not match b_hash",
    );
  }
  const dk = joinShares(a, bShare);
  registerSecretMaterial(dk);
  const secret = openSecret(dk, o.enc.ct, {
    project_id: o.enc.project_id,
    secret: o.enc.secret,
    gen: o.enc.gen,
  });
  registerSecretMaterial(secret);

  return { secret, h, payTx: res.payTx, hcs: res.body.hcs, timings: { restoreMs, releaseMs } };
}
