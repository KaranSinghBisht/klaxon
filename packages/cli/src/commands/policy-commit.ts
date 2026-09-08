import { Command } from "commander";
import { policyPath } from "../config/paths.js";
import { readPolicyFile } from "../config/policy.js";
import { loadProjectContext } from "../context.js";
import type { CliDeps } from "../deps.js";
import { CliError } from "../errors.js";
import { encodeCommitPolicy } from "../registry/calldata.js";
import { sendCalls } from "../registry/send.js";

export interface PolicyCommitOptions {
  project?: string;
  file?: string;
  network?: string;
  dryRun?: boolean;
  printOnly?: boolean;
}

/**
 * Hashes the exact committed bytes of `klaxon.policy.json` and anchors them on Sepolia. The hash
 * and the calldata are printed before the device is asked for anything, so what the Ledger blind-
 * signs can be compared against what is on screen.
 */
export async function runPolicyCommit(deps: CliDeps, opts: PolicyCommitOptions): Promise<string> {
  const ctx = loadProjectContext(deps, opts.project);
  const file = opts.file ?? policyPath(deps.cwd);
  const policy = readPolicyFile(file);
  if (policy.policy.project_id !== ctx.project.project_id) {
    throw new CliError(
      "POLICY_MALFORMED",
      `${file} names project_id ${policy.policy.project_id}, but ${ctx.name} is ${ctx.project.project_id}`,
    );
  }
  const data = encodeCommitPolicy(ctx.project.project_id, policy.hash);
  deps.stdout(`policy_file ${file}\npolicy_hash ${policy.hash}\ncalldata    ${data}\n`);
  if (opts.printOnly) return policy.hash;
  await sendCalls(deps, ctx, [{ data, note: "commitPolicy" }], {
    ...(opts.network !== undefined ? { network: opts.network } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
  });
  return policy.hash;
}

export function makePolicyCommand(deps: CliDeps): Command {
  const policy = new Command("policy").description("klaxon.policy.json operations");
  policy
    .command("commit")
    .description("hash the committed policy bytes and anchor them with the Ledger")
    .option("--project <name>", "project in ~/.klaxon/config.json (default: default_project)")
    .option("--file <path>", "policy file (default: ./klaxon.policy.json)")
    .option("--network <id>", "wallet-cli network for account discovery")
    .option("--dry-run", "prepare and validate the transaction without asking the device")
    .option("--print-only", "print the hash and calldata and stop")
    .action(async (opts: PolicyCommitOptions) => {
      await runPolicyCommit(deps, opts);
    });
  return policy;
}
