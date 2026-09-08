import { commitmentHash, NO_ENVIRONMENT, verifyCommitmentSig } from "@klaxon/core";
import type { CheckDeps, CheckFail, OidcClaims, ReleaseAttempt } from "./types.js";
import { fail, pass } from "./types.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  CHECK 3 — THE CLAIM CROSS-CHECK. THE SINGLE MOST IMPORTANT LINE IN THIS PACKAGE (A §0.5, D38).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A runner asks GitHub for a token with **any** audience it likes. So `aud == "klaxon:" + h`
 * proves only that *some* job asked for that audience — it proves nothing about whether `C`'s
 * fields describe that job. A malicious install-phase job can build a `C` that claims
 * `environment: "production"`, get a token whose real `environment` claim is absent, and `aud`
 * will still match `h` perfectly.
 *
 * The lines below are what make `aud` mean anything: every GitHub-derived field of `C` must equal
 * the token's own claim, with an absent `environment` claim matching the `"(none)"` sentinel
 * exactly. Delete them and the entire commitment binding — the thing this protocol is about —
 * becomes decorative.
 *
 * This check catches the *lie*, not the absence. A job with no environment that says so honestly
 * passes here and is refused by check 4 as `policy`, which is what revokes the project.
 *
 * NEVER CUT (D38).
 */
export function checkCommitment(
  _deps: CheckDeps,
  attempt: ReleaseAttempt,
  claims: OidcClaims,
): { ok: true } | CheckFail {
  const { C, h } = { C: attempt.C, h: attempt.h };

  if (commitmentHash(C) !== h) {
    return fail("auth", 3, "commitment hash does not match the requested h");
  }
  if (!verifyCommitmentSig(C.ephemeral_pub, h, attempt.body.sig)) {
    return fail("auth", 3, "commitment signature is not valid for the declared ephemeral key");
  }
  if (C.project_id !== attempt.project.project_id) {
    return fail("auth", 3, "commitment names a different project");
  }

  // ---- the cross-check ----
  if (C.repository_id !== claims.repository_id) {
    return fail("auth", 3, "C.repository_id does not match the token's repository_id claim");
  }
  if (C.run_id !== claims.run_id) {
    return fail("auth", 3, "C.run_id does not match the token's run_id claim");
  }
  if (C.run_attempt !== claims.run_attempt) {
    return fail("auth", 3, "C.run_attempt does not match the token's run_attempt claim");
  }

  // The `environment` claim exists only when the job declared `environment:`. An absent claim is
  // faithfully described by the sentinel, so a job with no environment can still make an *honest*
  // commitment — and it is check 4 that refuses it, as `policy`, because "(none)" is not a policy
  // environment. That distinction is the money shot: the worm's request is truthful, paid for,
  // and refused on the record with the project revoked.
  //
  // What dies here is the *lie*: a commitment claiming `environment: "production"` while the
  // token carries no claim at all (or a different one). That is the A §0.5 attack, and without
  // this comparison `aud` would bind nothing.
  const claimedEnvironment = claims.environment === "" ? NO_ENVIRONMENT : claims.environment;
  if (C.environment !== claimedEnvironment) {
    return fail(
      "auth",
      3,
      claims.environment === ""
        ? `C.environment says "${C.environment}" but the token carries no environment claim`
        : "C.environment does not match the token's environment claim",
    );
  }
  return pass();
}
