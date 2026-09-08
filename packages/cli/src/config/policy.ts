import { readFileSync, writeFileSync } from "node:fs";
import { type Policy, PolicySchema, sha256 } from "@klaxon/core";
import { CliError } from "../errors.js";

export interface PolicyFile {
  /** The exact committed bytes. `policyHash` is over these and nothing else (A §4.3). */
  bytes: Buffer;
  policy: Policy;
  hash: string;
}

export interface PolicySkeletonArgs {
  projectId: string;
  repositoryId: string;
  environments?: Record<string, { secrets: string[]; max_releases?: number }>;
  maxReleases?: number;
}

export function policySkeleton(a: PolicySkeletonArgs): Policy {
  return PolicySchema.parse({
    klaxon: 1,
    project_id: a.projectId,
    repository_id: a.repositoryId,
    max_releases: a.maxReleases ?? 50,
    environments: a.environments ?? { production: { secrets: ["EXAMPLE_SECRET"] } },
    workflow_rules: { forbid_install_steps: true, require_pinned_uses: true },
  });
}

/** How this CLI writes a policy it authored. Reading one back never goes through here. */
export function serializePolicy(p: Policy): string {
  return `${JSON.stringify(p, null, 2)}\n`;
}

/**
 * `policyHash = sha256(exact bytes of the file as committed)` — never a re-serialization.
 * `klaxon policy commit`, the witness and `verify` all hash the same raw bytes, so a formatter
 * run over `klaxon.policy.json` is a policy change and has to be re-committed on chain.
 */
export function hashPolicyBytes(bytes: Uint8Array): string {
  return sha256(bytes).toString("hex");
}

export function readPolicyFile(file: string): PolicyFile {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (cause) {
    throw new CliError("POLICY_MISSING", `no policy file at ${file}`, { cause });
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new CliError("POLICY_MALFORMED", `${file} is not valid JSON`, { cause });
  }
  const parsed = PolicySchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      "POLICY_MALFORMED",
      `${file} failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return { bytes, policy: parsed.data, hash: hashPolicyBytes(bytes) };
}

export function writePolicyFile(file: string, policy: Policy): PolicyFile {
  const text = serializePolicy(policy);
  writeFileSync(file, text, { mode: 0o644 });
  const bytes = Buffer.from(text, "utf8");
  return { bytes, policy, hash: hashPolicyBytes(bytes) };
}
