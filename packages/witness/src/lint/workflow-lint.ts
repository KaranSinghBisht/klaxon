import { parse as parseYaml } from "yaml";
import { GITHUB_EXPRESSION, isPinnedImage, isPinnedUses, matchInstallPattern } from "./patterns.js";

/**
 * A §5.6. Answers one question: *does the job that carries this environment run anything it could
 * have fetched from the internet, and is everything it runs from — actions, and the container the
 * steps run inside — pinned to something immutable?*
 *
 * A YAML parse failure is an error, never a clean result — treating an unreadable workflow as
 * "no install step found" is exactly the failure mode this file exists to prevent (B §5.7). The
 * same principle covers the smaller unreadables: a job whose `steps:` is not a list, a step that is
 * not a mapping, a `container:` that is not an image, and a `run:` carrying an unresolved
 * `${{ … }}` are all *findings*, because none of them can be shown to be clean.
 */
export class WorkflowParseError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`workflow ${path} is not parseable YAML`, { cause });
    this.name = "WorkflowParseError";
    this.path = path;
  }
}

export type FindingKind =
  | "install"
  | "unpinned"
  | "unpinned-container"
  | "unresolvable-environment"
  | "unresolvable-run"
  /** The job is not shaped like a job. We cannot read it, so we cannot call it clean. */
  | "malformed";

export interface LintFinding {
  kind: FindingKind;
  file: string;
  job: string;
  detail: string;
}

export interface LintResult {
  /** Jobs across all files that declare exactly this environment. */
  matchedJobs: string[];
  findings: LintFinding[];
}

export interface WorkflowSource {
  path: string;
  text: string;
}

interface RawStep {
  run?: unknown;
  uses?: unknown;
  name?: unknown;
}

interface RawJob {
  environment?: unknown;
  steps?: unknown;
  uses?: unknown;
  container?: unknown;
}

/** `environment:` is a string or `{name, url}`; anything else is not something we can reason about. */
function environmentName(value: unknown): { name: string | null; unresolvable: boolean } {
  if (typeof value === "string") {
    return { name: value, unresolvable: GITHUB_EXPRESSION.test(value) };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string") {
      return { name, unresolvable: GITHUB_EXPRESSION.test(name) };
    }
    // An object with no usable `name` still declares *some* environment we cannot identify.
    return { name: null, unresolvable: true };
  }
  if (value === undefined || value === null) return { name: null, unresolvable: false };
  return { name: null, unresolvable: true };
}

/**
 * `steps:` is a list. Anything else — a mapping, a string, a `${{ }}`, or nothing at all — is a job
 * this file cannot read, and an unreadable job is a finding rather than a clean one (B §5.7).
 * Returning `[]` for it meant a malformed job produced *zero* findings and passed the check.
 */
function stepsOf(file: string, jobId: string, job: RawJob, findings: LintFinding[]): unknown[] {
  if (Array.isArray(job.steps)) return job.steps as unknown[];
  if (job.steps === undefined || job.steps === null) {
    // A job that only calls a reusable workflow has no steps of its own; its job-level `uses:` is
    // linted separately, and `job_workflow_ref` names the file that actually ran.
    if (typeof job.uses === "string") return [];
    findings.push({
      kind: "malformed",
      file,
      job: jobId,
      detail: "job declares neither steps: nor uses:, so there is nothing to check it against",
    });
    return [];
  }
  findings.push({
    kind: "malformed",
    file,
    job: jobId,
    detail: "steps: is not a list, so the job's steps cannot be read",
  });
  return [];
}

/**
 * `container:` is an image string or `{image, …}`. It runs *before* the job's steps do, so an
 * unpinned image is arbitrary code holding the environment's secrets — `container: node:latest`
 * passed this lint until it was inspected, while the docs told people to pin the digest.
 */
function lintContainer(file: string, jobId: string, job: RawJob, findings: LintFinding[]): void {
  const value = job.container;
  if (value === undefined || value === null) return;
  const image = containerImage(value);
  if (image === null) {
    findings.push({
      kind: "malformed",
      file,
      job: jobId,
      detail: "container: is neither an image nor a mapping carrying an image:",
    });
    return;
  }
  // An expression cannot be a digest either — it resolves on the runner, long after this check.
  if (!isPinnedImage(image)) {
    findings.push({
      kind: "unpinned-container",
      file,
      job: jobId,
      detail: `container image "${image}" is not pinned to a sha256 digest`,
    });
  }
}

function containerImage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const image = (value as { image?: unknown }).image;
    if (typeof image === "string") return image;
  }
  return null;
}

function stepLabel(step: RawStep, index: number): string {
  return typeof step.name === "string" && step.name.length > 0 ? step.name : `step ${index + 1}`;
}

function lintJob(file: string, jobId: string, job: RawJob, findings: LintFinding[]): void {
  // A job-level `uses:` calls a reusable workflow; it is an action reference and must be pinned.
  if (typeof job.uses === "string" && !isPinnedUses(job.uses)) {
    findings.push({
      kind: "unpinned",
      file,
      job: jobId,
      detail: `job-level uses "${job.uses}" is not pinned to a 40-hex commit sha`,
    });
  }
  lintContainer(file, jobId, job, findings);
  for (const [i, step] of stepsOf(file, jobId, job, findings).entries()) {
    lintStep(file, jobId, step, i, findings);
  }
}

function lintStep(
  file: string,
  jobId: string,
  raw: unknown,
  index: number,
  findings: LintFinding[],
): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    findings.push({
      kind: "malformed",
      file,
      job: jobId,
      detail: `step ${index + 1} is not a mapping`,
    });
    return;
  }
  const step = raw as RawStep;
  if (typeof step.run === "string") {
    lintRun(file, jobId, step, step.run, index, findings);
  }
  if (typeof step.uses === "string" && !isPinnedUses(step.uses)) {
    findings.push({
      kind: "unpinned",
      file,
      job: jobId,
      detail: `${stepLabel(step, index)} uses "${step.uses}", not pinned to a 40-hex commit sha`,
    });
  }
}

function lintRun(
  file: string,
  jobId: string,
  step: RawStep,
  run: string,
  index: number,
  findings: LintFinding[],
): void {
  if (GITHUB_EXPRESSION.test(run)) {
    // `${{ … }}` is substituted on the runner, *after* this check: `${{ env.SETUP }}` can expand to
    // `npm i` and no literal pattern here would ever see it. The honest answer is that the step is
    // unlintable — the same answer `environment:` gets when it cannot be resolved statically.
    findings.push({
      kind: "unresolvable-run",
      file,
      job: jobId,
      detail: `${stepLabel(step, index)} runs a GitHub expression that cannot be resolved statically`,
    });
    return;
  }
  const hit = matchInstallPattern(run);
  if (hit) {
    findings.push({
      kind: "install",
      file,
      job: jobId,
      detail: `${stepLabel(step, index)} runs an install step (${hit.name})`,
    });
  }
}

/**
 * Lints every job that declares `environment`. Jobs with an unresolvable `environment:` are
 * reported wherever they appear: we cannot prove such a job is *not* the one being released to,
 * so the safe reading is to refuse (A §5.6).
 */
export function lintWorkflows(files: WorkflowSource[], environment: string): LintResult {
  const findings: LintFinding[] = [];
  const matchedJobs: string[] = [];

  for (const file of files) {
    let doc: unknown;
    try {
      doc = parseYaml(file.text);
    } catch (cause) {
      throw new WorkflowParseError(file.path, cause);
    }
    const jobs = (doc as { jobs?: unknown } | null)?.jobs;
    if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) continue;

    for (const [jobId, rawJob] of Object.entries(jobs as Record<string, unknown>)) {
      // A job that is not a mapping declares no `environment:`, so it cannot be the job under
      // test — and Actions would have refused to run the file at all. Findings are raised only
      // against the matched job, so that an unrelated file at the same commit cannot refuse a
      // release that has nothing to do with it.
      if (!rawJob || typeof rawJob !== "object") continue;
      const job = rawJob as RawJob;
      const env = environmentName(job.environment);
      if (env.unresolvable) {
        findings.push({
          kind: "unresolvable-environment",
          file: file.path,
          job: jobId,
          detail: "environment: is a GitHub expression and cannot be resolved statically",
        });
        continue;
      }
      if (env.name !== environment) continue;
      matchedJobs.push(`${file.path}#${jobId}`);
      lintJob(file.path, jobId, job, findings);
    }
  }

  return { matchedJobs, findings };
}
