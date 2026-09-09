import type { WorkflowSource } from "../lint/workflow-lint.js";
import { type LintResult, lintWorkflows, WorkflowParseError } from "../lint/workflow-lint.js";
import { SourceFetchError } from "../ports/index.js";
import type { CheckDeps, CheckFail, OidcClaims, ReleaseAttempt } from "./types.js";
import { fail, pass } from "./types.js";

/**
 * Check 5 — the job that carries this environment is clean at the commit the token names
 * (PROTOCOL §6.5): no install step, every `uses:` pinned to a 40-hex sha.
 *
 * Three refusals happen before the lint even runs:
 *  - a pull-request event (D25): `pull_request`'s `sha` claim is a merge commit that does not
 *    exist in the repository's history, and `pull_request_target` runs the base repo's workflow —
 *    real sha, real secrets — against a fork's head. Neither is a commit whose workflow can be
 *    checked, and `pull_request_target` is the more dangerous of the two, so refusing only the
 *    literal `"pull_request"` left the door open.
 *  - a reusable workflow from outside the project (D26): deny-by-default, stated posture.
 *  - a fetch or parse failure: `infra`. An unreadable workflow must never read as a clean one.
 */
export async function checkWorkflow(
  deps: CheckDeps,
  attempt: ReleaseAttempt,
  claims: OidcClaims,
): Promise<{ ok: true } | CheckFail> {
  // `auth`, not `policy`: any same-repo PR that happens to run the action lands here, so a
  // `policy` class revoked the project — permanently, recoverable only with the physical Ledger —
  // for an ordinary pull request. Refusing a request the witness will not serve is not evidence
  // that the project's policy has been broken.
  if (claims.event_name === "pull_request" || claims.event_name === "pull_request_target") {
    return fail("auth", 5, `release from a ${claims.event_name} event is refused`);
  }

  const target = resolveWorkflowTarget(claims, attempt.project.repository);
  if (!target.ok) return target.failure;

  let files: WorkflowSource[];
  try {
    files = await loadWorkflows(deps, attempt.project.repository, target.sha, target.path);
  } catch (err) {
    if (err instanceof SourceFetchError && err.notFound) {
      return fail("policy", 5, "no workflow file exists at the commit the token names");
    }
    return fail("infra", 5, "workflow files could not be fetched");
  }

  let result: LintResult;
  try {
    result = lintWorkflows(files, attempt.C.environment);
  } catch (err) {
    if (err instanceof WorkflowParseError) {
      return fail("infra", 5, `workflow ${err.path} could not be parsed`);
    }
    return fail("infra", 5, "workflow lint failed");
  }

  const unresolvable = result.findings.find((f) => f.kind === "unresolvable-environment");
  if (unresolvable) {
    return fail("policy", 5, `${unresolvable.job}: ${unresolvable.detail}`);
  }
  if (result.matchedJobs.length === 0) {
    return fail("policy", 5, `no job declares environment "${attempt.C.environment}"`);
  }
  const offending = result.findings[0];
  if (offending) {
    // Revocation is expensive to undo — a Ledger and an on-chain transaction — so it is reserved
    // for findings that say someone tried to take a secret they were not entitled to. A workflow
    // whose *shape* cannot be linted is refused just as hard, but the project stays live: the
    // operator fixes it by editing their own repository, and `${{ }}` inside a `run:` is far too
    // common in honest workflows to be worth bricking CI over.
    return fail(
      SHAPE_ONLY_FINDINGS.has(offending.kind) ? "auth" : "policy",
      5,
      `${offending.job}: ${offending.detail}`,
    );
  }
  return pass();
}

/** Refused, never revoked: these are unlintable workflows, not attempts on a secret. */
const SHAPE_ONLY_FINDINGS: ReadonlySet<string> = new Set(["malformed", "unresolvable-run"]);

type WorkflowTarget =
  | { ok: true; sha: string; path: string | null }
  | { ok: false; failure: CheckFail };

/**
 * `job_workflow_ref` is `owner/repo/.github/workflows/x.yml@refs/heads/main` and names the file the
 * job actually ran from — a reusable workflow when it differs from `workflow_ref`. Fetching at
 * `job_workflow_sha` rather than the ref is what stops a mutable branch swapping the file.
 */
export function resolveWorkflowTarget(claims: OidcClaims, repository: string): WorkflowTarget {
  const ref = claims.job_workflow_ref;
  if (!ref) {
    // No ref to work from: fall back to listing every workflow at the commit.
    return { ok: true, sha: claims.sha, path: null };
  }
  const parsed = /^(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<path>.+)@(?<gitref>.+)$/.exec(ref);
  if (!parsed?.groups) {
    return { ok: false, failure: fail("policy", 5, "job_workflow_ref is not parseable") };
  }
  const { owner, repo, path } = parsed.groups as { owner: string; repo: string; path: string };
  if (`${owner}/${repo}`.toLowerCase() !== repository.toLowerCase()) {
    // D26: deny-by-default for the demo, and the correct posture regardless.
    return {
      ok: false,
      failure: fail(
        "policy",
        5,
        `job ran from a reusable workflow in ${owner}/${repo}, outside this project`,
      ),
    };
  }
  return { ok: true, sha: claims.job_workflow_sha || claims.sha, path };
}

async function loadWorkflows(
  deps: CheckDeps,
  repository: string,
  sha: string,
  path: string | null,
): Promise<WorkflowSource[]> {
  if (path) {
    const text = await cachedFetch(deps, repository, sha, path);
    return [{ path, text }];
  }
  const listed = await deps.source.listWorkflows(repository, sha);
  if (listed.length === 0) {
    throw new SourceFetchError("no workflow files at this commit", { notFound: true });
  }
  return listed.map((f) => ({ path: f.path, text: f.bytes.toString("utf8") }));
}

/** A commit sha is immutable, so a cache hit is always the same bytes GitHub would return. */
async function cachedFetch(
  deps: CheckDeps,
  repository: string,
  sha: string,
  path: string,
): Promise<string> {
  const cached = deps.repos.workflowCache.get(repository, sha, path);
  if (cached !== null) return cached;
  const bytes = await deps.source.fetch(repository, sha, path);
  const text = bytes.toString("utf8");
  deps.repos.workflowCache.put(repository, sha, path, text, deps.clock().toISOString());
  return text;
}
