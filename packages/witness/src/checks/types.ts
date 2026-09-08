import type { Commitment, Policy, ReleaseRequestBody } from "@klaxon/core";
import type { ProjectRow, Repos } from "../db/index.js";
import type { WitnessConfig } from "../env.js";
import type { Logger } from "../log.js";
import type { Clock, OidcPort, PaymentPort, SourcePort } from "../ports/index.js";

/**
 * PROTOCOL §6 taxonomy. Failing 1–3 is `auth`, failing 4–9 is `policy` (and revokes, except 7 —
 * D16), and *any* infrastructure error anywhere is `infra`: 503, no HCS message, no revoke.
 */
export type RefusalClass = "auth" | "policy" | "infra";

export interface CheckFail {
  ok: false;
  class: RefusalClass;
  check: number;
  reason: string;
}

export function fail(cls: RefusalClass, check: number, reason: string): CheckFail {
  return { ok: false, class: cls, check, reason };
}

export function pass(): { ok: true } {
  return { ok: true };
}

export function passWith<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** GitHub OIDC claims the witness reads. Everything numeric is normalised to a string (D17). */
export interface OidcClaims {
  repository: string;
  repository_id: string;
  run_id: string;
  run_attempt: string;
  /** Empty string when the job declared no `environment:` — the money-shot case (A §0.5). */
  environment: string;
  sha: string;
  workflow_ref: string;
  workflow_sha: string;
  job_workflow_ref: string;
  job_workflow_sha: string;
  event_name: string;
  runner_environment: string;
  jti: string;
  raw: Record<string, unknown>;
}

/** Everything the pipeline threads through the checks. */
export interface ReleaseAttempt {
  h: string;
  body: ReleaseRequestBody;
  C: Commitment;
  payTx: string;
  project: ProjectRow;
  now: Date;
}

export interface CheckDeps {
  config: WitnessConfig;
  repos: Repos;
  payment: PaymentPort;
  source: SourcePort;
  oidc: OidcPort;
  clock: Clock;
  log: Logger;
}

/** Carried forward between checks so later ones do not refetch what an earlier one proved. */
export interface CheckState {
  claims?: OidcClaims;
  policy?: Policy;
  policyBytes?: Buffer;
}
