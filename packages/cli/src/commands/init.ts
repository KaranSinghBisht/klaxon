import { existsSync } from "node:fs";
import { deriveProjectId } from "@klaxon/core";
import { Command } from "commander";
import {
  type KlaxonConfig,
  loadConfig,
  type ProjectConfig,
  ProjectConfigSchema,
  saveConfig,
  upsertProject,
} from "../config/config-store.js";
import { configPath, operatorKeyPath, policyPath, stateDir } from "../config/paths.js";
import { policySkeleton, readPolicyFile, writePolicyFile } from "../config/policy.js";
import type { ProjectContext } from "../context.js";
import type { CliDeps } from "../deps.js";
import { CliError } from "../errors.js";
import { assertNetwork } from "../hedera/client.js";
import { loadMember } from "../member.js";
import { loadOrCreateOperatorKey } from "../operator.js";
import { encodeCommitPolicy, encodeRegister } from "../registry/calldata.js";
import { DEFAULT_EVM_NETWORK, sendCalls, walletCliFor } from "../registry/send.js";
import { extractAccountLabel } from "../wallet-cli/exec.js";
import { readSession, requireTrustchain } from "../wallet-cli/session.js";
import { WitnessClient } from "../witness-client.js";

export interface InitOptions {
  project?: string;
  repository?: string;
  repositoryId?: string;
  witness?: string;
  registry?: string;
  chainId?: string;
  hederaAccount?: string;
  hederaKey?: string;
  hederaKeyType?: string;
  hederaNetwork?: string;
  network?: string;
  payAccount?: string;
  skipRingInit?: boolean;
  dryRun?: boolean;
  printOnly?: boolean;
}

export interface InitResult {
  name: string;
  project: ProjectConfig;
  policyHash: string;
  topicId: string;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new CliError("BAD_ARGUMENT", `${flag} is required`);
  return value;
}

/**
 * One command, one device session, and the project exists: the Key Ring is initialised, the HCS
 * topic is created with the witness as the only permitted writer, the witness learns the project,
 * and the Ledger claims it on Sepolia with `register` + the first `commitPolicy` back to back (D19).
 */
export async function runInit(deps: CliDeps, opts: InitOptions): Promise<InitResult> {
  const repository = required(opts.repository, "--repository");
  const repositoryId = required(opts.repositoryId, "--repository-id");
  if (!/^[0-9]+$/.test(repositoryId)) {
    throw new CliError("BAD_ARGUMENT", "--repository-id is GitHub's numeric repository id");
  }
  const witnessUrl = required(opts.witness, "--witness").replace(/\/+$/, "");
  const registry = required(opts.registry, "--registry");
  const name = opts.project ?? repository.split("/")[1] ?? repository;
  const evmNetwork = opts.network ?? DEFAULT_EVM_NETWORK;

  const hederaAccount = opts.hederaAccount ?? deps.env.HEDERA_OPERATOR_ID;
  const hederaKey = opts.hederaKey ?? deps.env.HEDERA_OPERATOR_KEY;
  if (!hederaAccount || !hederaKey) {
    throw new CliError(
      "HEDERA_CONFIG_MISSING",
      "the laptop needs a Hedera account to own the topic's admin key — pass --hedera-account/--hedera-key or set HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY",
    );
  }

  const dir = stateDir(deps.env, deps.home);
  if (!opts.skipRingInit) {
    deps.stderr("wallet-cli ring init — approve on the device\n");
    await walletCliFor(deps, {}).ringInit();
  }
  const session = readSession(dir);
  const trustchain = requireTrustchain(session);
  const { member } = await loadMember({ stateDir: dir, keychain: deps.keychain, env: deps.env });

  // The admin surface gets its own key. The member credential above ships to every runner as an
  // input of `klaxon/get`, so it must not be able to authorise `/shares` (PROTOCOL §2).
  const operatorFile = operatorKeyPath(deps.env, deps.home);
  const { key: operator, created } = loadOrCreateOperatorKey(operatorFile);
  deps.stderr(
    created
      ? `operator key created at ${operatorFile} (mode 0600, back it up — it is not the member key)\n`
      : `operator key loaded from ${operatorFile}\n`,
  );

  const payAccount = opts.payAccount ?? deps.env.KLAXON_PAY_ACCOUNT;
  if (payAccount && !/^\d+\.\d+\.\d+$/.test(payAccount)) {
    throw new CliError("BAD_ARGUMENT", "--pay-account is a Hedera account id, e.g. 0.0.1234567");
  }
  if (!payAccount) {
    deps.stderr(
      "no --pay-account: check 1 will accept a payment from any account until one is registered\n",
    );
  }

  // D15: read the label out of the JSON. Never hardcode `ethereum-sepolia-1`/`ethereum_sepolia-1`.
  const discovered = await walletCliFor(deps, {}).accountDiscover(evmNetwork);
  const accountLabel = extractAccountLabel(discovered, evmNetwork);
  deps.stderr(`wallet-cli account label for ${evmNetwork}: ${accountLabel}\n`);

  const projectId = deriveProjectId(repositoryId, trustchain.rootId);
  const witness = new WitnessClient({
    baseUrl: witnessUrl,
    operator,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
  const manifest = await witness.manifest();

  const hederaNetwork = assertNetwork(opts.hederaNetwork ?? "testnet");
  const { topicId } = await deps.createTopic({
    accountId: hederaAccount,
    privateKey: hederaKey,
    keyType: opts.hederaKeyType === "ed25519" ? "ed25519" : "ecdsa",
    network: hederaNetwork,
    memo: `klaxon:${projectId}`,
    submitKeyHex: manifest.submit_key,
  });
  deps.stderr(`hcs topic ${topicId} (submit key = witness, admin key = this laptop)\n`);

  // D29: the ntfy topic name is the password, so it is 32 hex characters of nothing else.
  const ntfyTopic = `klaxon-${deps.randomHex(16)}`;
  await witness.registerProject({
    project_id: projectId,
    repository_id: repositoryId,
    repository,
    member_pubkey: member.pubkey,
    operator_pubkey: operator.pubkey,
    ...(payAccount ? { pay_account: payAccount } : {}),
    topic_id: topicId,
    ntfy_topic: ntfyTopic,
  });

  const policyFile = policyPath(deps.cwd);
  const policy = existsSync(policyFile)
    ? readPolicyFile(policyFile)
    : writePolicyFile(policyFile, policySkeleton({ projectId, repositoryId }));
  if (policy.policy.project_id !== projectId) {
    throw new CliError(
      "POLICY_MALFORMED",
      `${policyFile} already exists and names a different project_id`,
    );
  }

  const project = ProjectConfigSchema.parse({
    project_id: projectId,
    repository,
    repository_id: repositoryId,
    trustchain_root_id: trustchain.rootId,
    application_path: trustchain.applicationPath,
    application_id: 17,
    witness_url: witnessUrl,
    topic_id: topicId,
    registry_address: registry,
    chain_id: opts.chainId ? Number(opts.chainId) : 11155111,
    hedera_account: manifest.hedera_account,
    hedera_network: hederaNetwork,
    member_pubkey: member.pubkey,
    operator_pubkey: operator.pubkey,
    ...(payAccount ? { pay_account: payAccount } : {}),
    ntfy_topic: ntfyTopic,
    account_label: accountLabel,
    last_epoch: 0,
  });
  const configFile = configPath(deps.env, deps.home);
  const config: KlaxonConfig = upsertProject(loadConfig(configFile), name, project);
  saveConfig(configFile, config);
  deps.stdout(
    `project     ${name}\nproject_id  ${projectId}\ntopic_id    ${topicId}\npolicy      ${policyFile}\npolicy_hash ${policy.hash}\nntfy        ${ntfyTopic}\nconfig      ${configFile}\n`,
  );

  if (!opts.printOnly) {
    const ctx: ProjectContext = { configFile, config, name, project, stateDir: dir };
    await sendCalls(
      deps,
      ctx,
      [
        { data: encodeRegister(projectId), note: "register" },
        { data: encodeCommitPolicy(projectId, policy.hash), note: "commitPolicy" },
      ],
      { network: evmNetwork, ...(opts.dryRun ? { dryRun: true } : {}) },
    );
  }
  deps.stderr("edit klaxon.policy.json, then `klaxon policy commit` to anchor the real one.\n");
  return { name, project, policyHash: policy.hash, topicId };
}

export function makeInitCommand(deps: CliDeps): Command {
  return new Command("init")
    .description(
      "create a KLAXON project: Key Ring, HCS topic, witness registration, Sepolia claim",
    )
    .requiredOption("--repository <org/repo>", "GitHub repository")
    .requiredOption("--repository-id <id>", "GitHub numeric repository id")
    .requiredOption("--witness <url>", "witness base URL")
    .requiredOption("--registry <address>", "KlaxonRegistry address on Sepolia")
    .option("--project <name>", "local name in ~/.klaxon/config.json (default: the repo name)")
    .option("--chain-id <n>", "EVM chain id (default: 11155111)")
    .option("--hedera-account <id>", "laptop Hedera account (default: HEDERA_OPERATOR_ID)")
    .option("--hedera-key <key>", "its private key (default: HEDERA_OPERATOR_KEY)")
    .option("--hedera-key-type <type>", "ecdsa (default) or ed25519")
    .option("--hedera-network <name>", "testnet (default), mainnet or previewnet")
    .option("--network <id>", `wallet-cli network (default: ${DEFAULT_EVM_NETWORK})`)
    .option(
      "--pay-account <id>",
      "Hedera account the runner pays from; check 1 binds the debit to it (default: KLAXON_PAY_ACCOUNT)",
    )
    .option("--skip-ring-init", "the Key Ring is already initialised on this machine")
    .option("--dry-run", "prepare and validate the Sepolia transactions without asking the device")
    .option("--print-only", "stop before register/commitPolicy")
    .action(async (opts: InitOptions) => {
      await runInit(deps, opts);
    });
}
