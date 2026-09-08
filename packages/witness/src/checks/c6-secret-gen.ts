import type { Policy } from "@klaxon/core";
import type { CheckDeps, CheckFail, ReleaseAttempt } from "./types.js";
import { fail, pass } from "./types.js";

/**
 * Check 6 — this secret is allowed in this environment, at the current generation, and the witness
 * actually holds a share record for it (PROTOCOL §6.6).
 *
 * The generation comparison is what makes `rotate` bite: after a rotation, a captured gen-N share
 * A is inert because gen N is no longer current and its share row is retired.
 */
export function checkSecretGeneration(
  deps: CheckDeps,
  attempt: ReleaseAttempt,
  policy: Policy,
): { ok: true } | CheckFail {
  const env = policy.environments[attempt.C.environment];
  if (!env) {
    return fail("policy", 6, `environment "${attempt.C.environment}" is not in the policy`);
  }
  if (!env.secrets.includes(attempt.C.secret)) {
    return fail(
      "policy",
      6,
      `secret ${attempt.C.secret} is not released to environment "${attempt.C.environment}"`,
    );
  }

  // Compared as strings: `gen` is a JSON string in C (D17), so "07" is not "7" and never will be.
  if (attempt.C.gen !== String(attempt.project.current_gen)) {
    return fail(
      "policy",
      6,
      `generation ${attempt.C.gen} is not current (current is ${attempt.project.current_gen})`,
    );
  }

  const share = deps.repos.shares.get(
    attempt.project.project_id,
    attempt.C.secret,
    Number(attempt.C.gen),
  );
  if (!share) {
    return fail("policy", 6, `no share is registered for ${attempt.C.secret} gen ${attempt.C.gen}`);
  }
  if (share.retired !== 0) {
    return fail("policy", 6, `share for ${attempt.C.secret} gen ${attempt.C.gen} is retired`);
  }
  return pass();
}
