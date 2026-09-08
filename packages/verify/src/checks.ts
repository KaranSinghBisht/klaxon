import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import type { JWTPayload } from "jose";
import { checkMaxReleases, checkRevocationWindows, type MaxReleasesGroup } from "./aggregate.js";
import { commitmentHash } from "./canonical.js";
import type { AttemptRecord, RevokeRecord, UnrevokeRecord } from "./envelope.js";
import { type Finding, finding } from "./errors.js";
import {
  claimsOf,
  type JwksOptions,
  type JwksSnapshot,
  type JwtSource,
  verifyAtTime,
} from "./jwks.js";
import type { Pairing } from "./pair.js";
import {
  environmentAllowed,
  maxReleasesFor,
  type PolicyCache,
  type PolicyFetch,
  repoRef,
  secretAllowed,
} from "./policy.js";
import { policyHashAt, type RegistryTimeline } from "./registry.js";
import { CommitmentSchema } from "./schema.js";
import { parseTs, tsSeconds } from "./timestamp.js";

/** Domain separation (D24): the 64-byte signature can never be replayed over another value. */
export const SIG_DOMAIN = "klaxon-release-v1:";
/** PROTOCOL §1 — what `C.environment` holds when the job carried no environment claim. */
export const NO_ENVIRONMENT = "(none)";

// SubjectPublicKeyInfo DER prefix for a raw 32-byte Ed25519 key (RFC 8410).
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export function verifyCommitmentSig(sigPubB64u: string, h: string, sigB64u: string): boolean {
  try {
    const raw = Buffer.from(sigPubB64u, "base64url");
    const signature = Buffer.from(sigB64u, "base64url");
    if (raw.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, raw]),
      format: "der",
      type: "spki",
    });
    return ed25519Verify(null, Buffer.from(SIG_DOMAIN + h, "utf8"), key, signature);
  } catch {
    return false;
  }
}

/** `n/a` is the emergency path: no OIDC token and no policy to bind it to. */
export type PolicyState = "matched" | "mismatch" | "unverifiable" | "n/a";
export type EnvSecretState = "ok" | "fail" | "unknown" | "n/a";

export interface AttemptCheck {
  type: "released" | "refused" | "emergency";
  h: string;
  payTx: string;
  paymentConsensus: string;
  messageConsensus: string;
  projectId: string;
  secret: string | null;
  gen: string | null;
  environment: string | null;
  commitmentValid: boolean;
  hRecomputed: boolean;
  /** `null` where the row does not apply — an `emergency` carries no sig, token or policy. */
  sigValid: boolean | null;
  audBinds: boolean | null;
  claimsMatch: boolean | null;
  jwt: { ok: boolean | null; source?: JwtSource; snapshotTimestamp?: string; reason?: string };
  policy: { state: PolicyState; expected?: string; actual?: string; reason?: string };
  envSecret: { state: EnvSecretState; reason?: string };
  refusal?: { class: string; check: number; reason: string };
  findings: Finding[];
}

export type { MaxReleasesGroup } from "./aggregate.js";

export interface ChecksResult {
  attempts: AttemptCheck[];
  maxReleases: MaxReleasesGroup[];
  findings: Finding[];
}

export interface ChecksContext {
  snapshots: readonly JwksSnapshot[];
  policies: PolicyCache;
  timeline: RegistryTimeline | null;
  revokes: readonly RevokeRecord[];
  unrevokes: readonly UnrevokeRecord[];
  /** Swappable so tests never reach GitHub; defaults to the live-then-snapshot path. */
  verifyJwt?: typeof verifyAtTime;
  /** Passed straight through to `verifyAtTime`; tests inject a local key set here. */
  jwksOptions?: JwksOptions;
}

function claimString(claims: JWTPayload | null, name: string): string | null {
  const value = claims?.[name];
  return value === undefined || value === null ? null : String(value);
}

/**
 * A `refused` message documents a request the witness rejected, so a failing check on one is
 * evidence about the *requester*, not about the witness. It is reported and never counted as a
 * protocol violation — only `released` and `emergency` put the publisher on the hook.
 */
function severityFor(type: AttemptRecord["type"]): { severity?: "unverified" } {
  return type === "refused" ? { severity: "unverified" } : {};
}

/**
 * PROTOCOL §7 — the operator's break-glass recovery. It commits to its own canonical object
 * and pays with that hash as the memo, so `h` is still re-derivable from public data; there is
 * simply no OIDC token, no ephemeral signature and no policy to bind it to.
 */
function checkEmergency(
  attempt: AttemptRecord,
  paymentConsensus: string,
  paymentMemo: string,
): AttemptCheck {
  const findings: Finding[] = [];
  const recomputed = commitmentHash(attempt.commitment);
  const hRecomputed = recomputed === attempt.h && attempt.h === paymentMemo;
  if (!hRecomputed) {
    findings.push(
      finding(
        "H_MISMATCH",
        `sha256(JCS(emergency commitment)) = ${recomputed}, message says ${attempt.h}, payment memo says ${paymentMemo}`,
        { h: attempt.h, pay_tx: attempt.payTx, at: attempt.consensusTimestamp },
      ),
    );
  }
  return {
    type: "emergency",
    h: attempt.h,
    payTx: attempt.payTx,
    paymentConsensus,
    messageConsensus: attempt.consensusTimestamp,
    projectId: attempt.projectId,
    secret: attempt.emergency?.secret ?? null,
    gen: attempt.emergency?.gen ?? null,
    environment: null,
    commitmentValid: true,
    hRecomputed,
    sigValid: null,
    audBinds: null,
    claimsMatch: null,
    jwt: { ok: null },
    policy: { state: "n/a", reason: "emergency recovery carries no policy binding" },
    envSecret: { state: "n/a" },
    findings,
  };
}

async function checkAttempt(
  attempt: AttemptRecord,
  paymentConsensus: string,
  paymentMemo: string,
  ctx: ChecksContext,
): Promise<AttemptCheck> {
  if (attempt.type === "emergency") {
    return checkEmergency(attempt, paymentConsensus, paymentMemo);
  }
  const findings: Finding[] = [];
  const where = { h: attempt.h, pay_tx: attempt.payTx, at: attempt.consensusTimestamp };
  const soft = severityFor(attempt.type);
  const verifyJwt = ctx.verifyJwt ?? verifyAtTime;

  const parsed = CommitmentSchema.safeParse(attempt.commitment);
  const commitment = parsed.success ? parsed.data : null;
  if (!parsed.success) {
    findings.push(
      finding(
        "COMMITMENT_MALFORMED",
        `C does not match the commitment schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        { ...where, ...soft },
      ),
    );
  }

  // 1 — h is recomputed from C by an implementation that shares no code with the witness (D5).
  const recomputed = commitment ? commitmentHash(commitment) : null;
  const hRecomputed = recomputed !== null && recomputed === attempt.h && attempt.h === paymentMemo;
  if (!hRecomputed) {
    findings.push(
      finding(
        "H_MISMATCH",
        recomputed === null
          ? "could not recompute h: C is unusable"
          : `sha256(JCS(C)) = ${recomputed}, message says ${attempt.h}, payment memo says ${paymentMemo}`,
        { ...where, ...soft },
      ),
    );
  }

  // 2 — the ephemeral key in C signed this exact h.
  const sigValid =
    commitment !== null &&
    verifyCommitmentSig(commitment.ephemeral_pub.sig, attempt.h, attempt.sig);
  if (!sigValid) {
    findings.push(
      finding("SIG_INVALID", `sig does not verify under C.ephemeral_pub.sig for ${attempt.h}`, {
        ...where,
        ...soft,
      }),
    );
  }

  // 3 — the JWT, evaluated at the payment's consensus time (D22), not at ours.
  const consensusSeconds = tsSeconds(paymentConsensus);
  const jwtResult = await verifyJwt(
    attempt.jwt,
    attempt.h,
    consensusSeconds,
    ctx.snapshots,
    ctx.jwksOptions ?? {},
  );
  const jwt: AttemptCheck["jwt"] = jwtResult.ok
    ? {
        ok: true,
        source: jwtResult.source,
        ...(jwtResult.snapshotTimestamp ? { snapshotTimestamp: jwtResult.snapshotTimestamp } : {}),
      }
    : { ok: false, reason: jwtResult.reason };
  if (!jwtResult.ok) {
    findings.push(
      finding(jwtResult.code, jwtResult.reason, {
        ...where,
        ...(jwtResult.code === "JWKS_UNAVAILABLE" ? {} : soft),
      }),
    );
  }

  // 4 — `aud` binds this commitment, and 5 — C repeats the token's own claims (A §0.5).
  const claims = claimsOf(attempt.jwt);
  const audience = claims?.aud;
  const audienceList = Array.isArray(audience) ? audience : audience ? [audience] : [];
  const audBinds = audienceList.includes(`klaxon:${attempt.h}`);
  if (!audBinds) {
    findings.push(
      finding(
        "AUD_MISMATCH",
        `aud ${JSON.stringify(audience ?? null)} is not klaxon:${attempt.h}`,
        {
          ...where,
          ...soft,
        },
      ),
    );
  }

  const mismatches: string[] = [];
  if (commitment) {
    const expected: [string, string][] = [
      ["repository_id", commitment.repository_id],
      ["run_id", commitment.run_id],
      ["run_attempt", commitment.run_attempt],
      ["environment", commitment.environment],
    ];
    for (const [name, value] of expected) {
      const claimed = claimString(claims, name) ?? (name === "environment" ? NO_ENVIRONMENT : null);
      if (claimed !== value) mismatches.push(`${name}: C=${value} jwt=${claimed ?? "(absent)"}`);
    }
  }
  const claimsMatch = commitment !== null && mismatches.length === 0;
  if (!claimsMatch) {
    findings.push(
      finding(
        "CLAIM_MISMATCH",
        commitment ? `C disagrees with the token — ${mismatches.join("; ")}` : "no usable C",
        { ...where, ...soft },
      ),
    );
  }

  // 6 — the policy the run committed, hashed and compared with the chain at payment time.
  const check = await checkPolicy(attempt, commitment, claims, paymentConsensus, ctx);
  for (const f of check.findings) findings.push(f);

  const result: AttemptCheck = {
    type: attempt.type,
    h: attempt.h,
    payTx: attempt.payTx,
    paymentConsensus,
    messageConsensus: attempt.consensusTimestamp,
    projectId: commitment?.project_id ?? attempt.projectId,
    secret: commitment?.secret ?? null,
    gen: commitment?.gen ?? null,
    environment: commitment?.environment ?? null,
    commitmentValid: commitment !== null,
    hRecomputed,
    sigValid,
    audBinds,
    claimsMatch,
    jwt,
    policy: check.policy,
    envSecret: check.envSecret,
    findings,
  };
  if (attempt.refusal) result.refusal = attempt.refusal;
  return result;
}

interface PolicyOutcome {
  policy: AttemptCheck["policy"];
  envSecret: AttemptCheck["envSecret"];
  findings: Finding[];
}

async function checkPolicy(
  attempt: AttemptRecord,
  commitment: { project_id: string; environment: string; secret: string } | null,
  claims: JWTPayload | null,
  paymentConsensus: string,
  ctx: ChecksContext,
): Promise<PolicyOutcome> {
  const findings: Finding[] = [];
  const where = { h: attempt.h, pay_tx: attempt.payTx, at: attempt.consensusTimestamp };
  const soft = severityFor(attempt.type);
  const unverifiable = (reason: string): PolicyOutcome => {
    findings.push(finding("POLICY_UNVERIFIABLE", reason, where));
    return {
      policy: { state: "unverifiable", reason },
      envSecret: { state: "unknown", reason },
      findings,
    };
  };

  if (!commitment) return unverifiable("no usable C");
  if (!ctx.timeline) {
    return unverifiable("no KlaxonRegistry timeline — pass --registry to bind the policy on chain");
  }
  const ref = repoRef(claims?.repository);
  const sha = claimString(claims, "sha");
  if (!ref || !sha) {
    return unverifiable("the token carries no usable repository/sha claim to fetch the policy at");
  }

  const anchored = policyHashAt(ctx.timeline, commitment.project_id, parseTs(paymentConsensus)[0]);
  if (!anchored) {
    return unverifiable(
      `no PolicyCommitted for ${commitment.project_id} at or before ${paymentConsensus} in blocks ${ctx.timeline.fromBlock}-${ctx.timeline.toBlock}`,
    );
  }

  const fetched: PolicyFetch = await ctx.policies.get(ref, sha);
  if (!fetched.ok) return unverifiable(fetched.reason);

  if (fetched.hash !== anchored.hash) {
    const detail = `policy at ${ref.owner}/${ref.repo}@${sha} hashes to ${fetched.hash}; Sepolia had ${anchored.hash} in force at ${paymentConsensus}`;
    findings.push(finding("POLICY_MISMATCH", detail, { ...where, ...soft }));
    return {
      policy: { state: "mismatch", expected: anchored.hash, actual: fetched.hash, reason: detail },
      envSecret: { state: "unknown", reason: "policy hash did not match" },
      findings,
    };
  }

  const policyState: AttemptCheck["policy"] = {
    state: "matched",
    expected: anchored.hash,
    actual: fetched.hash,
  };

  // 7 — the environment and the secret must both be named by that exact policy.
  if (!environmentAllowed(fetched.policy, commitment.environment)) {
    const detail = `environment ${commitment.environment} is not in the committed policy`;
    findings.push(finding("ENV_NOT_IN_POLICY", detail, { ...where, ...soft }));
    return { policy: policyState, envSecret: { state: "fail", reason: detail }, findings };
  }
  if (!secretAllowed(fetched.policy, commitment.environment, commitment.secret)) {
    const detail = `${commitment.secret} is not listed for environment ${commitment.environment}`;
    findings.push(finding("SECRET_NOT_IN_POLICY", detail, { ...where, ...soft }));
    return { policy: policyState, envSecret: { state: "fail", reason: detail }, findings };
  }
  return { policy: policyState, envSecret: { state: "ok" }, findings };
}

/** Re-derive PROTOCOL §6 over every paired attempt, from public data only. */
export async function runChecks(
  pairs: readonly Pairing[],
  ctx: ChecksContext,
): Promise<ChecksResult> {
  const attempts: AttemptCheck[] = [];
  const limits = new Map<string, number>();

  for (const pair of pairs) {
    for (const attempt of [...pair.released, ...pair.emergency, ...pair.refused]) {
      const checked = await checkAttempt(
        attempt,
        pair.payment.consensusTimestamp,
        pair.payment.memo,
        ctx,
      );
      attempts.push(checked);
      if (checked.policy.state !== "matched" || !checked.secret || !checked.gen) continue;
      const ref = repoRef(claimsOf(attempt.jwt)?.repository);
      const sha = claimString(claimsOf(attempt.jwt), "sha");
      if (!ref || !sha || !checked.environment) continue;
      const fetched = await ctx.policies.get(ref, sha);
      if (!fetched.ok) continue;
      limits.set(
        `${checked.projectId}/${checked.secret}/${checked.gen}`,
        maxReleasesFor(fetched.policy, checked.environment),
      );
    }
  }

  const budget = checkMaxReleases(attempts, limits);
  const findings = [
    ...budget.findings,
    ...checkRevocationWindows(attempts, ctx.revokes, ctx.timeline),
  ];
  return { attempts, maxReleases: budget.groups, findings };
}
