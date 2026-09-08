import { Command } from "commander";
import { contextMember, loadProjectContext, persistProject, witnessFor } from "../context.js";
import type { CliDeps } from "../deps.js";
import { CliError } from "../errors.js";

export interface RevokeOptions {
  project?: string;
  reason?: string;
}

/**
 * The panic button. It is member-signed rather than device-signed on purpose: revocation has to
 * be reachable from a phone tether at 3 a.m. without the Ledger in the room. Coming back is the
 * part that costs a device approval (`unrevoke`).
 */
export async function runRevoke(deps: CliDeps, opts: RevokeOptions): Promise<number> {
  const reason = opts.reason?.trim();
  if (!reason) throw new CliError("BAD_ARGUMENT", "--reason is required: say what happened");
  const ctx = loadProjectContext(deps, opts.project);
  const member = await contextMember(deps, ctx);
  const witness = witnessFor(deps, ctx.project, member);
  const { epoch } = await witness.revoke(ctx.project.project_id, reason);
  persistProject(ctx, { ...ctx.project, last_epoch: Math.max(ctx.project.last_epoch, epoch) });
  deps.stdout(`revoked ${ctx.name} epoch=${epoch}\n`);
  deps.stderr(
    `every release for this project now refuses. \`klaxon unrevoke\` needs the Ledger and epoch ${epoch + 1}.\n`,
  );
  return epoch;
}

export function makeRevokeCommand(deps: CliDeps): Command {
  return new Command("revoke")
    .description("stop all releases for a project (member-signed, no device)")
    .option("--project <name>", "project in ~/.klaxon/config.json (default: default_project)")
    .requiredOption("--reason <text>", "what happened — recorded on HCS")
    .action(async (opts: RevokeOptions) => {
      await runRevoke(deps, opts);
    });
}
