import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  emitGithubMasks,
  getSecret,
  parseEncFile,
  type ReleaseTransport,
  registerSecretMaterial,
} from "@klaxon/core";
import { Command } from "commander";
import { encFilePath } from "../config/paths.js";
import { contextMember, loadProjectContext } from "../context.js";
import type { CliDeps } from "../deps.js";
import { CliError } from "../errors.js";
import { githubOidc } from "../oidc.js";
import { assertSecretName } from "./add.js";

export interface GetOptions {
  project?: string;
  transport?: string;
  iKnowWhatImDoing?: boolean;
}

export interface TransportFactoryArgs {
  witnessUrl: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}

type TransportFactory = (a: TransportFactoryArgs) => ReleaseTransport | Promise<ReleaseTransport>;

const NO_TRANSPORT_HELP = [
  "`klaxon get` has no payment transport of its own.",
  "The x402 client lives in the GitHub Action (packages/action), which is the only place that",
  "may load @x402/* — this package must never import it (D33: one Hedera SDK copy per package).",
  "",
  "In CI: use the action.",
  "Elsewhere: --transport <module> pointing at a module that exports",
  "  createTransport({ witnessUrl, env, fetchImpl }) => ReleaseTransport",
].join("\n");

/**
 * Loads a `ReleaseTransport` from an operator-supplied module. A path is resolved against the
 * cwd; anything else is treated as a bare specifier so a workspace package works too.
 */
export async function loadTransport(
  spec: string,
  args: TransportFactoryArgs,
  cwd: string,
): Promise<ReleaseTransport> {
  const target =
    spec.startsWith(".") || isAbsolute(spec) ? pathToFileURL(resolve(cwd, spec)).href : spec;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(target)) as Record<string, unknown>;
  } catch (cause) {
    throw new CliError("NO_TRANSPORT", `could not load transport module ${spec}`, { cause });
  }
  const factory = (mod.createTransport ?? mod.default) as TransportFactory | undefined;
  if (typeof factory !== "function") {
    throw new CliError(
      "NO_TRANSPORT",
      `${spec} exports no createTransport(...) and no default export`,
    );
  }
  return factory(args);
}

/**
 * The runner path. Everything load-bearing is in core's `getSecret` — this command only supplies
 * the ports (OIDC, transport, wsek restore) and decides where the plaintext is allowed to go.
 */
export async function runGet(deps: CliDeps, name: string, opts: GetOptions): Promise<void> {
  assertSecretName(name);
  if (deps.isTty() && !opts.iKnowWhatImDoing) {
    throw new CliError(
      "TTY_REFUSED",
      "refusing to print a secret to a terminal — pipe it somewhere, or pass --i-know-what-im-doing",
    );
  }
  // Checked before anything is read: without a transport this command cannot work at all, and
  // saying so beats a config error the operator would fix for nothing.
  if (!opts.transport) throw new CliError("NO_TRANSPORT", NO_TRANSPORT_HELP);

  const ctx = loadProjectContext(deps, opts.project);
  const path = encFilePath(deps.cwd, name);
  let enc: ReturnType<typeof parseEncFile>;
  try {
    enc = parseEncFile(JSON.parse(readFileSync(path, "utf8")));
  } catch (cause) {
    throw new CliError("ENC_MISSING", `cannot read ${path}`, { cause });
  }

  const member = await contextMember(deps, ctx);
  const transport = await loadTransport(
    opts.transport,
    { witnessUrl: ctx.project.witness_url, env: deps.env, fetchImpl: deps.fetchImpl },
    deps.cwd,
  );

  const result = await getSecret({
    enc,
    member,
    oidc: githubOidc(deps.env, deps.fetchImpl),
    transport,
    restore: deps.restoreWsek,
    clock: deps.now,
  });

  // Masks first, on their own lines, before anything can echo the value (A §2.10). Masking is
  // literal, so the exact rendering about to be printed is registered alongside core's encodings.
  const rendered = result.secret.toString("utf8");
  registerSecretMaterial(rendered);
  if (deps.env.GITHUB_ACTIONS === "true" || deps.env.CI === "true") {
    emitGithubMasks((line) => deps.stdout(`${line}\n`));
  }
  deps.stdout(`${rendered}\n`);
  deps.stderr(
    `released h=${result.h} pay_tx=${result.payTx} hcs=${result.hcs.sequence_number}@${result.hcs.consensus_timestamp}\n`,
  );
}

export function makeGetCommand(deps: CliDeps): Command {
  return new Command("get")
    .description("release a secret on a runner (pays the witness, prints the plaintext once)")
    .argument("<NAME>", "secret name")
    .option("--project <name>", "project in ~/.klaxon/config.json (default: default_project)")
    .option(
      "--transport <module>",
      "module exporting createTransport({witnessUrl, env, fetchImpl})",
    )
    .option("--i-know-what-im-doing", "allow printing the plaintext to a terminal")
    .action(async (name: string, opts: GetOptions) => {
      await runGet(deps, name, opts);
    });
}
