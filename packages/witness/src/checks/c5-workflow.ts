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
 *  - `event_name == "pull_request"` (D25): the `sha` claim is a merge commit that does not exist
 *    in the repository's history, so "the workflow at that sha" is not a stable thing to check.
 *  - a reusable workflow from outside the project (D26): deny-by-default, stated posture.
 *  - a fetch or parse failure: `infra`. An unreadable workflow must never read as a clean one.
 */
export async function checkWorkflow(
  deps: CheckDeps,
  attempt: ReleaseAttempt,
  claims: OidcClaims,
): Promise<{ ok: true } | CheckFail> {
  if (claims.event_name === "pull_request") {
    return fail("policy", 5, "release from a pull_request event is refused");
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
    return fail("policy", 5, `${offending.job}: ${offending.detail}`);
  }
  return pass();
}

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
