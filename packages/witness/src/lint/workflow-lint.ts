import { parse as parseYaml } from "yaml";
import { GITHUB_EXPRESSION, isPinnedUses, matchInstallPattern } from "./patterns.js";

/**
 * A §5.6. Answers one question: *does the job that carries this environment run anything it could
 * have fetched from the internet, and is every action it uses pinned to an immutable sha?*
 *
 * A YAML parse failure is an error, never a clean result — treating an unreadable workflow as
 * "no install step found" is exactly the failure mode this file exists to prevent (B §5.7).
 */
export class WorkflowParseError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`workflow ${path} is not parseable YAML`, { cause });
    this.name = "WorkflowParseError";
    this.path = path;
  }
}

export type FindingKind = "install" | "unpinned" | "unresolvable-environment";

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

function stepsOf(job: RawJob): RawStep[] {
  return Array.isArray(job.steps) ? (job.steps as RawStep[]) : [];
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
  for (const [i, step] of stepsOf(job).entries()) {
    if (typeof step.run === "string") {
      const hit = matchInstallPattern(step.run);
      if (hit) {
        findings.push({
          kind: "install",
          file,
          job: jobId,
          detail: `${stepLabel(step, i)} runs an install step (${hit.name})`,
        });
      }
    }
    if (typeof step.uses === "string" && !isPinnedUses(step.uses)) {
      findings.push({
        kind: "unpinned",
        file,
        job: jobId,
        detail: `${stepLabel(step, i)} uses "${step.uses}", not pinned to a 40-hex commit sha`,
      });
    }
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
