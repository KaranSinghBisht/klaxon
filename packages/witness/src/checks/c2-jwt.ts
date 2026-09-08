import { oidcAudience } from "@klaxon/core";
import { errors as joseErrors, jwtVerify } from "jose";
import type { CheckDeps, CheckFail, OidcClaims, ReleaseAttempt } from "./types.js";
import { fail, passWith } from "./types.js";

/**
 * Check 2 — the OIDC token is a real GitHub token, minted for *this* commitment hash
 * (PROTOCOL §6.2). `aud == "klaxon:" + h` is a replay defence, not a binding: a runner can ask
 * GitHub for any audience it likes, so what the token *says about the job* is only enforced by
 * check 3.
 *
 * JWKS unreachable is `infra`; a bad signature, a wrong audience or an expired token is `auth`.
 */
export async function checkJwt(
  deps: CheckDeps,
  attempt: ReleaseAttempt,
): Promise<{ ok: true; value: OidcClaims } | CheckFail> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(attempt.body.jwt, deps.oidc.keys, {
      issuer: deps.oidc.issuer,
      audience: oidcAudience(attempt.h),
      algorithms: ["RS256"],
      clockTolerance: deps.config.KLAXON_CLOCK_TOLERANCE_S,
      currentDate: attempt.now,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    return classifyJwtError(err);
  }

  const claims = readClaims(payload);
  for (const required of ["repository_id", "run_id", "run_attempt", "sha"] as const) {
    if (!claims[required]) return fail("auth", 2, `token has no ${required} claim`);
  }
  if (claims.repository_id !== attempt.project.repository_id) {
    // Bound to the numeric id, never the name: repositories can be renamed, ids cannot.
    return fail("auth", 2, "token repository_id does not belong to this project");
  }
  return passWith(claims);
}

function classifyJwtError(err: unknown): CheckFail {
  if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSMultipleMatchingKeys) {
    return fail("infra", 2, "JWKS could not be resolved");
  }
  if (err instanceof joseErrors.JOSEError) {
    return fail("auth", 2, `jwt rejected: ${err.code}`);
  }
  // Anything that is not a JOSE error at all reached us from `fetch` — GitHub is unwell, not the
  // runner. Refusing here would revoke a project because of someone else's outage.
  return fail("infra", 2, "JWKS fetch failed");
}

function claimString(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

export function readClaims(payload: Record<string, unknown>): OidcClaims {
  return {
    repository: claimString(payload, "repository"),
    repository_id: claimString(payload, "repository_id"),
    run_id: claimString(payload, "run_id"),
    run_attempt: claimString(payload, "run_attempt"),
    environment: claimString(payload, "environment"),
    sha: claimString(payload, "sha"),
    workflow_ref: claimString(payload, "workflow_ref"),
    workflow_sha: claimString(payload, "workflow_sha"),
    job_workflow_ref: claimString(payload, "job_workflow_ref"),
    job_workflow_sha: claimString(payload, "job_workflow_sha"),
    event_name: claimString(payload, "event_name"),
    runner_environment: claimString(payload, "runner_environment"),
    jti: claimString(payload, "jti"),
    raw: payload,
  };
}
