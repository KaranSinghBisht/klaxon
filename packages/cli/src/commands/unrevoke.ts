import { Command } from "commander";
import { loadProjectContext, persistProject } from "../context.js";
import type { CliDeps } from "../deps.js";
import { CliError } from "../errors.js";
import { encodeUnrevoke } from "../registry/calldata.js";
import { sendCalls } from "../registry/send.js";

export interface UnrevokeOptions {
  project?: string;
  epoch?: string;
  network?: string;
  dryRun?: boolean;
  printOnly?: boolean;
}

/**
 * `KlaxonRegistry.unrevoke(p, epoch)` is monotonic on chain, so the epoch has to be strictly
 * greater than the last one. The last one this laptop knows about lives in
 * `~/.klaxon/config.json`; `--epoch` is the escape hatch when the chain is ahead of the file.
 */
export async function runUnrevoke(deps: CliDeps, opts: UnrevokeOptions): Promise<bigint> {
  const ctx = loadProjectContext(deps, opts.project);
  let epoch: bigint;
  if (opts.epoch !== undefined) {
    if (!/^[0-9]+$/.test(opts.epoch)) throw new CliError("BAD_ARGUMENT", "--epoch must be digits");
    epoch = BigInt(opts.epoch);
  } else {
    epoch = BigInt(ctx.project.last_epoch) + 1n;
  }
  const data = encodeUnrevoke(ctx.project.project_id, epoch);
  deps.stdout(`epoch    ${epoch}\ncalldata ${data}\n`);
  if (opts.printOnly) return epoch;
  await sendCalls(deps, ctx, [{ data, note: `unrevoke epoch ${epoch}` }], {
    ...(opts.network !== undefined ? { network: opts.network } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
  });
  if (!opts.dryRun) {
    persistProject(ctx, { ...ctx.project, last_epoch: Number(epoch) });
  }
  return epoch;
}

export function makeUnrevokeCommand(deps: CliDeps): Command {
  return new Command("unrevoke")
    .description("lift a revocation on Sepolia (needs the Ledger)")
    .option("--project <name>", "project in ~/.klaxon/config.json (default: default_project)")
    .option("--epoch <n>", "epoch to submit (default: last known + 1)")
    .option("--network <id>", "wallet-cli network for account discovery")
    .option("--dry-run", "prepare and validate the transaction without asking the device")
    .option("--print-only", "print the epoch and calldata and stop")
    .action(async (opts: UnrevokeOptions) => {
      await runUnrevoke(deps, opts);
    });
}
