import { Command } from "commander";
import type { CliDeps } from "../deps.js";
import { type AddOptions, runWriteSecret } from "./add.js";

/**
 * `rotate` is `add` at generation N+1. The witness retires generation N when it answers
 * `/rotate`, so an old `.enc` still in someone's checkout stops releasing without any revocation.
 */
export function makeRotateCommand(deps: CliDeps): Command {
  return new Command("rotate")
    .description("re-encrypt a secret at the next generation and retire the previous one")
    .argument("<NAME>", "secret name")
    .option("--project <name>", "project in ~/.klaxon/config.json (default: default_project)")
    .option("--file <path>", "read the new value from a file instead of stdin")
    .option("--raw", "do not strip one trailing newline from the input")
    .action(async (name: string, opts: AddOptions) => {
      await runWriteSecret(deps, name, opts, "rotate");
    });
}
