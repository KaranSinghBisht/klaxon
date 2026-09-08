import { readFileSync } from "node:fs";
import {
  b64u,
  emitGithubMasks,
  joinShares,
  openSecret,
  parseEncFile,
  registerSecretMaterial,
  ringDecrypt,
  shareHash,
} from "@klaxon/core";
import { Command } from "commander";
import { encFilePath, witnessMasterPath } from "../config/paths.js";
import { contextMember, loadProjectContext } from "../context.js";
import type { CliDeps } from "../deps.js";
import { CliError } from "../errors.js";
import { assertNetwork } from "../hedera/client.js";
import {
  deriveShareB,
  emergencyCommitment,
  emergencyMemo,
  parseWitnessMaster,
} from "../share-b.js";
import { assertSecretName } from "./add.js";

export interface EmergencyOptions {
  project?: string;
  masterFile?: string;
  payAccount?: string;
  payKey?: string;
  payKeyType?: string;
  amount?: string;
  network?: string;
  noPay?: boolean;
  iKnowWhatImDoing?: boolean;
}

/** PROTOCOL §4's manifest price, in tinybars. Overridable because the witness may have moved it. */
export const DEFAULT_MEMO_TINYBARS = "100000";

function readMaster(deps: CliDeps, opts: EmergencyOptions): Buffer {
  if (opts.masterFile) return parseWitnessMaster(readFileSync(opts.masterFile, "utf8"));
  const fromEnv = deps.env.WITNESS_MASTER;
  if (fromEnv) return parseWitnessMaster(fromEnv);
  const fallback = witnessMasterPath(deps.env, deps.home);
  try {
    return parseWitnessMaster(readFileSync(fallback, "utf8"));
  } catch (cause) {
    throw new CliError(
      "MASTER_MISSING",
      `no WITNESS_MASTER in the environment and no ${fallback} — this is the paper backup`,
      { cause },
    );
  }
}

/**
 * Break glass: recover a secret with no witness at all. B comes from the paper-backed master
 * (D28), A comes out of the repo's `.enc` via the Key Ring, and the two XOR back to the data key.
 *
 * Ledger's trustchain API is still required — `restoreTrustchain` is what turns the member
 * credential into the wallet-sync key that opens share A, and it is a network call every time
 * (risk 2, disclosed). If Ledger's backend is down, this command cannot run either.
 */
export async function runEmergency(
  deps: CliDeps,
  name: string,
  opts: EmergencyOptions,
): Promise<{ h: string; payTx: string | undefined }> {
  assertSecretName(name);
  if (deps.isTty() && !opts.iKnowWhatImDoing) {
    throw new CliError(
      "TTY_REFUSED",
      "refusing to print a secret to a terminal — pipe it somewhere, or pass --i-know-what-im-doing",
    );
  }
  const ctx = loadProjectContext(deps, opts.project);
  const path = encFilePath(deps.cwd, name);
  let enc: ReturnType<typeof parseEncFile>;
  try {
    enc = parseEncFile(JSON.parse(readFileSync(path, "utf8")));
  } catch (cause) {
    throw new CliError("ENC_MISSING", `cannot read ${path}`, { cause });
  }

  const master = readMaster(deps, opts);
  const shareB = deriveShareB(master, enc.project_id, enc.secret, enc.gen);
  registerSecretMaterial(master, shareB);
  if (shareHash(shareB) !== enc.b_hash) {
    throw new CliError(
      "SHARE_MISMATCH",
      "the derived B does not match b_hash — wrong master, or this .enc came from another witness",
    );
  }

  const member = await contextMember(deps, ctx);
  const wsek = await deps.restoreWsek(member);
  const shareA = ringDecrypt(wsek, enc.a_key_name, b64u.decode(enc.a_ct));
  const dk = joinShares(shareA, shareB);
  registerSecretMaterial(shareA, dk);
  const plaintext = openSecret(dk, enc.ct, {
    project_id: enc.project_id,
    secret: enc.secret,
    gen: enc.gen,
  });
  // GitHub masking is literal: register the exact text that is about to be written, not only
  // the byte encodings core registers for it.
  const rendered = plaintext.toString("utf8");
  registerSecretMaterial(plaintext, rendered);

  const commitment = emergencyCommitment({
    project_id: enc.project_id,
    secret: enc.secret,
    gen: enc.gen,
    ts: deps.now().toISOString(),
  });
  const h = emergencyMemo(commitment);

  let payTx: string | undefined;
  if (!opts.noPay) {
    const accountId = opts.payAccount ?? deps.env.KLAXON_PAY_ACCOUNT;
    const privateKey = opts.payKey ?? deps.env.KLAXON_PAY_KEY;
    if (!accountId || !privateKey) {
      throw new CliError(
        "HEDERA_CONFIG_MISSING",
        "emergency pays from the laptop so the recovery is on chain — pass --pay-account/--pay-key (or KLAXON_PAY_ACCOUNT/KLAXON_PAY_KEY), or --no-pay to skip and say so out loud",
      );
    }
    const res = await deps.memoTransfer({
      accountId,
      privateKey,
      keyType: opts.payKeyType === "ed25519" ? "ed25519" : "ecdsa",
      network: assertNetwork(opts.network ?? ctx.project.hedera_network),
      to: ctx.project.hedera_account,
      amountTinybars: opts.amount ?? DEFAULT_MEMO_TINYBARS,
      memo: h,
    });
    payTx = res.payTx;
  }

  if (deps.env.GITHUB_ACTIONS === "true" || deps.env.CI === "true") {
    emitGithubMasks((line) => deps.stdout(`${line}\n`));
  }
  deps.stdout(`${rendered}\n`);
  deps.stderr(
    `emergency h=${h} pay_tx=${payTx ?? "(skipped)"} secret=${enc.secret} gen=${enc.gen}\n`,
  );
  if (opts.noPay) {
    deps.stderr("warning: --no-pay leaves no on-chain record of this recovery.\n");
  }
  return { h, payTx };
}

export function makeEmergencyCommand(deps: CliDeps): Command {
  return new Command("emergency")
    .description("recover a secret from the paper master and the repo, with no witness")
    .argument("<NAME>", "secret name")
    .option("--project <name>", "project in ~/.klaxon/config.json (default: default_project)")
    .option(
      "--master-file <path>",
      "file holding WITNESS_MASTER (default: env, then ~/.klaxon/witness-master.key)",
    )
    .option(
      "--pay-account <id>",
      "Hedera account paying for the memo (default: KLAXON_PAY_ACCOUNT)",
    )
    .option("--pay-key <key>", "its private key (default: KLAXON_PAY_KEY)")
    .option("--pay-key-type <type>", "ecdsa (default) or ed25519")
    .option("--amount <tinybars>", `memo transfer amount (default: ${DEFAULT_MEMO_TINYBARS})`)
    .option("--network <name>", "hedera network (default: the project's)")
    .option("--no-pay", "skip the on-chain memo — leaves no public trace")
    .option("--i-know-what-im-doing", "allow printing the plaintext to a terminal")
    .action(async (name: string, opts: EmergencyOptions) => {
      await runEmergency(deps, name, opts);
    });
}
