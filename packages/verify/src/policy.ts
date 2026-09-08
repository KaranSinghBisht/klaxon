import { sha256Hex } from "./canonical.js";
import type { FetchLike } from "./mirror/client.js";
import { type Policy, PolicySchema } from "./schema.js";

export const RAW_GITHUB = "https://raw.githubusercontent.com";
export const POLICY_PATH = "klaxon.policy.json";

export interface RepoRef {
  owner: string;
  repo: string;
}

export type PolicyFetch =
  | { ok: true; hash: string; bytes: Uint8Array; policy: Policy }
  | { ok: false; reason: string; status?: number };

/** The JWT's `repository` claim is `owner/repo`; the `sha` claim pins the commit (A §6.4). */
export function repoRef(repository: unknown): RepoRef | null {
  if (typeof repository !== "string") return null;
  const parts = repository.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo) return null;
  return { owner, repo };
}

export function policyUrl(ref: RepoRef, sha: string): string {
  return `${RAW_GITHUB}/${ref.owner}/${ref.repo}/${sha}/${POLICY_PATH}`;
}

/**
 * Fetch the policy the run actually committed, with no GitHub credentials (D7, A §6.4).
 *
 * A private repo answers 404 to an anonymous read, which is why the caller reports
 * `POLICY_UNVERIFIABLE` for those entries rather than passing them silently — an auditor that
 * cannot see the policy must say so, not assume the best.
 */
export async function fetchPolicyAt(
  ref: RepoRef,
  sha: string,
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
): Promise<PolicyFetch> {
  const url = policyUrl(ref, sha);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (error) {
    return {
      ok: false,
      reason: `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason:
        response.status === 404
          ? `${url} is not readable anonymously (private repo or missing at this sha)`
          : `HTTP ${response.status} for ${url}`,
    };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  // The hash is over the exact committed bytes (D36) — never over a re-serialised object.
  const hash = sha256Hex(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: `policy at ${sha} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const policy = PolicySchema.safeParse(parsed);
  if (!policy.success) {
    return {
      ok: false,
      reason: `policy at ${sha} does not match the schema: ${policy.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  return { ok: true, hash, bytes, policy: policy.data };
}

/** Per-environment override first, then the policy-wide default (D16). */
export function maxReleasesFor(policy: Policy, environment: string): number {
  return policy.environments[environment]?.max_releases ?? policy.max_releases;
}

export function environmentAllowed(policy: Policy, environment: string): boolean {
  return Object.hasOwn(policy.environments, environment);
}

export function secretAllowed(policy: Policy, environment: string, secret: string): boolean {
  return policy.environments[environment]?.secrets.includes(secret) ?? false;
}

/** One anonymous fetch per (repo, sha), however many releases cite it. */
export class PolicyCache {
  private readonly entries = new Map<string, Promise<PolicyFetch>>();

  constructor(private readonly fetchImpl?: FetchLike) {}

  get(ref: RepoRef, sha: string): Promise<PolicyFetch> {
    const key = `${ref.owner}/${ref.repo}@${sha}`;
    const existing = this.entries.get(key);
    if (existing) return existing;
    const pending = fetchPolicyAt(ref, sha, this.fetchImpl);
    this.entries.set(key, pending);
    return pending;
  }
}
