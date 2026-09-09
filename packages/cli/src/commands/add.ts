import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { addSecret, b64u, parseEncFile, serializeEncFile } from "@klaxon/core";
import { Command } from "commander";
import { encDir, encFilePath } from "../config/paths.js";
import { contextMember, loadProjectContext, witnessFor } from "../context.js";
import type { CliDeps } from "../deps.js";
import { CliError } from "../errors.js";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface AddOptions {
  project?: string;
  file?: string;
  /** Keep the bytes exactly as supplied instead of dropping one trailing newline. */
  raw?: boolean;
  force?: boolean;
}

export function assertSecretName(name: string): string {
  if (!SECRET_NAME.test(name)) {
    throw new CliError(
      "BAD_ARGUMENT",
      `secret name must match ${SECRET_NAME.source} (GitHub secret naming)`,
    );
  }
  return name;
}

async function readPlaintext(deps: CliDeps, opts: AddOptions): Promise<Buffer> {
  const bytes = opts.file ? readFileSync(opts.file) : await deps.readStdin();
  if (bytes.length === 0) throw new CliError("BAD_ARGUMENT", "refusing to store an empty secret");
  // One trailing newline is almost always the shell's, not the secret's.
  if (!opts.raw && bytes.at(-1) === 0x0a) return bytes.subarray(0, bytes.length - 1);
  return bytes;
}

export type WriteMode = "add" | "rotate";

/**
 * `add` and `rotate` are the same operation at two generations (D28): the witness derives B from
 * its master and hands it back over the operator-signed channel, the laptop computes A = DK ⊕ B and
 * Key-Ring-encrypts it into the repo. The witness keeps only `(project, secret, gen, b_hash)`.
 */
export async function runWriteSecret(
  deps: CliDeps,
  name: string,
  opts: AddOptions,
  mode: WriteMode,
): Promise<{ gen: string; path: string }> {
  assertSecretName(name);
  const ctx = loadProjectContext(deps, opts.project);
  const path = encFilePath(deps.cwd, name);
  const exists = existsSync(path);

  let gen: string;
  if (mode === "add") {
    if (exists && !opts.force) {
      throw new CliError(
        "ENC_EXISTS",
        `${path} already exists — use \`klaxon rotate ${name}\` to move to the next generation`,
      );
    }
    gen = "1";
  } else {
    if (!exists) {
      throw new CliError(
        "ENC_MISSING",
        `${path} does not exist — use \`klaxon add ${name}\` first`,
      );
    }
    const current = parseEncFile(JSON.parse(readFileSync(path, "utf8")));
    gen = (BigInt(current.gen) + 1n).toString();
  }

  const plaintext = await readPlaintext(deps, opts);
  const member = await contextMember(deps, ctx);
  const witness = witnessFor(deps, ctx.project);
  const share =
    mode === "add"
      ? await witness.shares(ctx.project.project_id, name, gen)
      : await witness.rotate(ctx.project.project_id, name, gen);

  // Ledger's API is a liveness dependency here and on every release (risk 2). Never cached.
  const wsek = await deps.restoreWsek(member);
  const enc = addSecret({
    projectId: ctx.project.project_id,
    secret: name,
    gen,
    plaintext,
    wsek,
    shareB: b64u.decode(share.b),
    createdAt: deps.now(),
  });
  if (enc.b_hash !== share.b_hash) {
    throw new CliError(
      "SHARE_MISMATCH",
      "the witness's b_hash does not match the share it returned — refusing to write .enc",
    );
  }

  mkdirSync(encDir(deps.cwd), { recursive: true });
  writeFileSync(path, serializeEncFile(enc), { mode: 0o644 });
  deps.stdout(`${path}  secret=${name} gen=${gen} b_hash=${enc.b_hash}\n`);
  deps.stderr(`commit ${path} — it is ciphertext, and the repo is where it belongs.\n`);
  return { gen, path };
}

function commonOptions(cmd: Command): Command {
  return cmd
    .option("--project <name>", "project in ~/.klaxon/config.json (default: default_project)")
    .option("--file <path>", "read the secret from a file instead of stdin")
    .option("--raw", "do not strip one trailing newline from the input");
}

export function makeAddCommand(deps: CliDeps): Command {
  return commonOptions(
    new Command("add")
      .description("encrypt a secret into .klaxon/<NAME>.enc at generation 1")
      .argument("<NAME>", "secret name, e.g. DEPLOYER_PRIVATE_KEY"),
  )
    .option("--force", "overwrite an existing .enc at generation 1")
    .action(async (name: string, opts: AddOptions) => {
      await runWriteSecret(deps, name, opts, "add");
    });
}
