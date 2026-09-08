import { NO_ENVIRONMENT, type Policy, PolicySchema, sha256 } from "@klaxon/core";
import { SourceFetchError } from "../ports/index.js";
import type { CheckDeps, CheckFail, OidcClaims, ReleaseAttempt } from "./types.js";
import { fail, passWith } from "./types.js";

export const POLICY_PATH = "klaxon.policy.json";

/**
 * Check 4 — the policy in force is the one anchored on Sepolia (PROTOCOL §6.4).
 *
 * Hashing the *exact committed bytes* is the point: the file is fetched at the token's own `sha`
 * over the same public path `verify` uses, and its sha256 must equal what the operator's Ledger
 * signed into `KlaxonRegistry`. A policy edited after the anchor was committed simply stops
 * matching.
 */
export async function checkPolicy(
  deps: CheckDeps,
  attempt: ReleaseAttempt,
  claims: OidcClaims,
): Promise<{ ok: true; value: { policy: Policy; bytes: Buffer } } | CheckFail> {
  if (!attempt.project.policy_hash) {
    return fail("policy", 4, "no policy hash has been committed on chain for this project");
  }

  let bytes: Buffer;
  try {
    bytes = await deps.source.fetch(attempt.project.repository, claims.sha, POLICY_PATH);
  } catch (err) {
    if (err instanceof SourceFetchError && err.notFound) {
      return fail("policy", 4, `${POLICY_PATH} does not exist at ${claims.sha}`);
    }
    return fail("infra", 4, "policy could not be fetched");
  }

  const digest = sha256(bytes).toString("hex");
  if (digest !== attempt.project.policy_hash.toLowerCase()) {
    return fail("policy", 4, "policy bytes do not match the hash anchored on Sepolia");
  }

  let policy: Policy;
  try {
    policy = PolicySchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return fail("policy", 4, "policy file is not a valid klaxon.policy.json");
  }
  if (policy.project_id !== attempt.project.project_id) {
    return fail("policy", 4, "policy names a different project");
  }
  if (!Object.hasOwn(policy.environments, attempt.C.environment)) {
    // `"(none)"` is the sentinel for a job that declared no `environment:`. It is never a policy
    // environment, so an honest request from such a job lands here — as `policy`, which revokes.
    // This is the demo's money shot, and the reason string is what the phone and the topic show.
    return fail(
      "policy",
      4,
      attempt.C.environment === NO_ENVIRONMENT
        ? "requested by a job with no environment"
        : `environment "${attempt.C.environment}" is not in the policy`,
    );
  }
  return passWith({ policy, bytes });
}
