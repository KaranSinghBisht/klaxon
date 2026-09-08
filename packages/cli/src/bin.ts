#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { KlaxonError } from "@klaxon/core";
import { Command, CommanderError } from "commander";
import { makeAddCommand } from "./commands/add.js";
import { makeEmergencyCommand } from "./commands/emergency.js";
import { makeExportMemberCommand } from "./commands/export-member.js";
import { makeGetCommand } from "./commands/get.js";
import { makeInitCommand } from "./commands/init.js";
import { makePolicyCommand } from "./commands/policy-commit.js";
import { makeRevokeCommand } from "./commands/revoke.js";
import { makeRotateCommand } from "./commands/rotate.js";
import { makeUnrevokeCommand } from "./commands/unrevoke.js";
import { type CliDeps, defaultDeps } from "./deps.js";
import { CliError } from "./errors.js";

export const VERSION = "0.1.0";

export function buildProgram(deps: CliDeps = defaultDeps()): Command {
  const program = new Command("klaxon")
    .description("KLAXON operator CLI — two-share CI secrets rooted in a Ledger Key Ring")
    .version(VERSION)
    .showHelpAfterError();
  program.configureOutput({
    writeOut: (s) => deps.stdout(s),
    writeErr: (s) => deps.stderr(s),
  });
  applyExitOverride(program);
  for (const cmd of [
    makeInitCommand(deps),
    makeExportMemberCommand(deps),
    makePolicyCommand(deps),
    makeAddCommand(deps),
    makeGetCommand(deps),
    makeRotateCommand(deps),
    makeRevokeCommand(deps),
    makeUnrevokeCommand(deps),
    makeEmergencyCommand(deps),
  ]) {
    applyExitOverride(cmd);
    program.addCommand(cmd);
  }
  return program;
}

/**
 * Commander calls `process.exit` from inside its parser by default, which makes usage errors
 * untestable and skips our own error formatting. Every command opts out; `main` turns the
 * resulting `CommanderError` back into an exit code.
 */
function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub);
}

/** Error text is operator-facing and never carries key material — see `CliError.detail`. */
export function formatError(err: unknown): string {
  if (err instanceof CliError) {
    return `error [${err.code}]: ${err.message}${err.detail ? `\n  ${err.detail.replace(/\n/g, "\n  ")}` : ""}\n`;
  }
  if (err instanceof KlaxonError) return `error [${err.code}]: ${err.message}\n`;
  return `error: ${err instanceof Error ? err.message : String(err)}\n`;
}

export async function main(args: string[], deps: CliDeps = defaultDeps()): Promise<number> {
  try {
    await buildProgram(deps).parseAsync(args, { from: "user" });
    return 0;
  } catch (err) {
    // `--help` and `--version` reach here as a zero-exit CommanderError; usage errors have
    // already been written by commander itself.
    if (err instanceof CommanderError) return err.exitCode;
    deps.stderr(formatError(err));
    return 1;
  }
}

/**
 * `process.argv[1]` is resolved but not realpath'd, so a `node_modules/.bin` symlink would not
 * match `import.meta.url` and the CLI would exit having done nothing. Compare the real paths.
 */
function invokedDirectly(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(argv.slice(2));
}
