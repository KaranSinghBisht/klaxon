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
import { contextMember, loadProjectContext, type ProjectContext } from "../context.js";
import type { CliDeps } from "../deps.js";
import { CliError } from "../errors.js";
import { assertNetwork, type HederaNetwork } from "../hedera/client.js";
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
  operatorAccount?: string;
  operatorKey?: string;
  operatorKeyType?: string;
  amount?: string;
  network?: string;
  noPay?: boolean;
  iKnowWhatImDoing?: boolean;
}

export interface EmergencyResult {
  h: string;
  payTx: string | undefined;
  sequenceNumber: string | undefined;
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
 * The laptop signs the HCS message as the second member of the topic's 1-of-2 submit KeyList,
 * which `init` built from `HEDERA_OPERATOR_KEY`. It falls back to the paying account only because
 * the two are usually the same laptop; if they are not, the publish will be rejected and the
 * operator is told to publish it by hand.
 */
function operatorCredentials(
  deps: CliDeps,
  opts: EmergencyOptions,
): { accountId: string; privateKey: string; keyType: "ecdsa" | "ed25519" } | undefined {
  const accountId =
    opts.operatorAccount ??
    deps.env.HEDERA_OPERATOR_ID ??
    opts.payAccount ??
    deps.env.KLAXON_PAY_ACCOUNT;
  const privateKey =
    opts.operatorKey ?? deps.env.HEDERA_OPERATOR_KEY ?? opts.payKey ?? deps.env.KLAXON_PAY_KEY;
  if (!accountId || !privateKey) return undefined;
  return {
    accountId,
    privateKey,
    keyType: opts.operatorKeyType === "ed25519" ? "ed25519" : "ecdsa",
  };
}

/**
 * PROTOCOL §7 `emergency`. Published before the plaintext exists in this process, so the record of
 * the recovery cannot be skipped by a later failure — but never load-bearing: an emergency that
 * cannot reach HCS still hands over the secret and says loudly that the record is incomplete.
 */
async function publishEmergency(
  deps: CliDeps,
  ctx: ProjectContext,
  opts: EmergencyOptions,
  body: {
    h: string;
    secret: string;
    gen: string;
    payTx: string;
    ts: string;
    network: HederaNetwork;
  },
): Promise<string | undefined> {
  const operator = operatorCredentials(deps, opts);
  if (!operator) {
    deps.stderr(
      "warning: no HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY — the emergency HCS record was NOT published.\n",
    );
    return undefined;
  }
  const message = JSON.stringify({
    klaxon: 1,
    type: "emergency",
    ts: body.ts,
    project_id: ctx.project.project_id,
    h: body.h,
    secret: body.secret,
    gen: body.gen,
    pay_tx: body.payTx,
  });
  try {
    const res = await deps.publishTopicMessage({
      ...operator,
      network: body.network,
      topicId: ctx.project.topic_id,
      message,
    });
    deps.stderr(`hcs emergency seq=${res.sequenceNumber} at ${res.consensusTimestamp}\n`);
    return res.sequenceNumber;
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    deps.stderr(
      `warning: the emergency HCS record was NOT published (${why}).\n` +
        `warning: the payment ${body.payTx} is on chain with no message beside it — publish this to topic ${ctx.project.topic_id} by hand:\n` +
        `${message}\n`,
    );
    return undefined;
  }
}

/**
 * Break glass: recover a secret with no witness at all. B comes from the paper-backed master
 * (D28), A comes out of the repo's `.enc` via the Key Ring, and the two XOR back to the data key.
 *
 * Ledger's trustchain API is still required — `restoreTrustchain` is what turns the member
 * credential into the wallet-sync key that opens share A, and it is a network call every time
 * (risk 2, disclosed). If Ledger's backend is down, this command cannot run either. It is called
 * before the payment so an outage costs nothing.
 */
export async function runEmergency(
  deps: CliDeps,
  name: string,
  opts: EmergencyOptions,
): Promise<EmergencyResult> {
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

  const ts = deps.now().toISOString();
  const h = emergencyMemo(
    emergencyCommitment({ project_id: enc.project_id, secret: enc.secret, gen: enc.gen, ts }),
  );
  const network = assertNetwork(opts.network ?? ctx.project.hedera_network);

  let payTx: string | undefined;
  let sequenceNumber: string | undefined;
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
      network,
      to: ctx.project.hedera_account,
      amountTinybars: opts.amount ?? DEFAULT_MEMO_TINYBARS,
      memo: h,
    });
    payTx = res.payTx;
    sequenceNumber = await publishEmergency(deps, ctx, opts, {
      h,
      secret: enc.secret,
      gen: enc.gen,
      payTx: res.payTx,
      ts,
      network,
    });
  }

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

  if (deps.env.GITHUB_ACTIONS === "true" || deps.env.CI === "true") {
    emitGithubMasks((line) => deps.stdout(`${line}\n`));
  }
  deps.stdout(`${rendered}\n`);
  deps.stderr(
    `emergency h=${h} pay_tx=${payTx ?? "(skipped)"} hcs=${sequenceNumber ?? "(none)"} secret=${enc.secret} gen=${enc.gen}\n`,
  );
  if (opts.noPay) {
    deps.stderr("warning: --no-pay left no on-chain record of this recovery — no memo, no HCS.\n");
  }
  return { h, payTx, sequenceNumber };
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
    .option(
      "--operator-account <id>",
      "account publishing the HCS record (default: HEDERA_OPERATOR_ID, then the paying account)",
    )
    .option("--operator-key <key>", "its private key (default: HEDERA_OPERATOR_KEY)")
    .option("--operator-key-type <type>", "ecdsa (default) or ed25519")
    .option("--amount <tinybars>", `memo transfer amount (default: ${DEFAULT_MEMO_TINYBARS})`)
    .option("--network <name>", "hedera network (default: the project's)")
    .option("--no-pay", "skip the on-chain memo and the HCS record — leaves no public trace")
    .option("--i-know-what-im-doing", "allow printing the plaintext to a terminal")
    .action(async (name: string, opts: EmergencyOptions) => {
      await runEmergency(deps, name, opts);
    });
}
