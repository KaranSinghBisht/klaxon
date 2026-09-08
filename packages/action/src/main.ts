import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import {
  decodeMember,
  type EncFile,
  emitGithubMasks,
  type GetSecretOptions,
  type GetSecretResult,
  getSecret,
  parseEncFile,
  restoreWalletSyncKey,
  type WsekRestorer,
} from "@klaxon/core";
import { wrapFetchWithPayment } from "@x402/fetch";
import { PrivateKey } from "@x402/hedera";
import { buildPayClient } from "./client.js";
import { describeFailure } from "./failures.js";
import { fetchWitnessAccount, normalizeWitness } from "./manifest.js";
import { STATE_COMMITMENT, STATE_PAY_TX } from "./state.js";
import { httpReleaseTransport, type KlaxonReleaseTransport } from "./transport.js";

export const DEFAULT_WITNESS = "https://klaxon-witness.fly.dev";
export const DEFAULT_MAX_TINYBARS = "200000";

/** The slice of `@actions/core` this action uses, so tests can hand `run` a fake. */
export interface ActionsCoreLike {
  getInput(name: string, options?: { required?: boolean }): string;
  setSecret(secret: string): void;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  info(message: string): void;
  saveState(name: string, value: string): void;
  getIDToken(audience?: string): Promise<string>;
}

export interface TransportOptions {
  witness: string;
  payAccount: string;
  payKey: string;
  maxTinybars: string;
}

export interface RunDeps {
  core: ActionsCoreLike;
  readEnc(path: string): string;
  buildTransport(o: TransportOptions): Promise<KlaxonReleaseTransport>;
  getSecret(o: GetSecretOptions): Promise<GetSecretResult>;
  restore: WsekRestorer;
  /** Writes one line to the job log — used only for `::add-mask::`, which must not be buffered. */
  writeLine(line: string): void;
}

function loadEncFile(read: (path: string) => string, name: string): EncFile {
  const path = `.klaxon/${name}.enc`;
  let raw: string;
  try {
    raw = read(path);
  } catch (cause) {
    throw new Error(`KLAXON: cannot read ${path} — is it committed to this repository?`, { cause });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`KLAXON: ${path} is not valid JSON`, { cause });
  }
  return parseEncFile(json);
}

/**
 * The whole action. Ordering is the security property: `setSecret` runs before the value can reach
 * any sink, the derived material is masked next, and only then is the value handed to the one step
 * that plumbs `steps.<id>.outputs.value` into its own `env:` (B §1.4).
 */
export async function run(deps: RunDeps): Promise<void> {
  const c = deps.core;
  let transport: KlaxonReleaseTransport | null = null;
  let payAccount = "";
  try {
    const name = c.getInput("secret", { required: true });
    const witness = normalizeWitness(c.getInput("witness") || DEFAULT_WITNESS);
    const member = decodeMember(c.getInput("member", { required: true }));
    payAccount = c.getInput("pay-account", { required: true });
    const payKey = c.getInput("pay-key", { required: true });
    const maxTinybars = c.getInput("max-tinybars") || DEFAULT_MAX_TINYBARS;

    const enc = loadEncFile(deps.readEnc, name);
    transport = await deps.buildTransport({ witness, payAccount, payKey, maxTinybars });

    const released = await deps.getSecret({
      enc,
      member,
      // `h` is only known after `C` is built, so the token is minted through this callback (D18).
      oidc: (audience: string) => c.getIDToken(audience),
      transport,
      restore: deps.restore,
    });

    const value = released.secret.toString("utf8");
    c.setSecret(value);
    emitGithubMasks(deps.writeLine);
    c.setOutput("value", value);
    // Only public, on-the-record values reach state — never the plaintext.
    c.saveState(STATE_COMMITMENT, released.h);
    c.saveState(STATE_PAY_TX, released.payTx);
    c.info(
      `KLAXON: ${name} released · commitment ${released.h} · paid ${released.payTx} · hcs #${released.hcs.sequence_number}`,
    );
  } catch (err) {
    c.setFailed(describeFailure(err, { refusal: transport?.lastRefusal() ?? null, payAccount }));
  }
}

async function buildTransport(o: TransportOptions): Promise<KlaxonReleaseTransport> {
  const witnessAccount = await fetchWitnessAccount(o.witness, fetch);
  const client = buildPayClient({
    payAccount: o.payAccount,
    payKey: PrivateKey.fromStringECDSA(o.payKey),
    witnessAccount,
    maxTinybars: o.maxTinybars,
  });
  return httpReleaseTransport(o.witness, wrapFetchWithPayment(fetch, client));
}

export function actionDeps(): RunDeps {
  return {
    core,
    readEnc: (path: string) => readFileSync(path, "utf8"),
    buildTransport,
    getSecret,
    restore: (member) => restoreWalletSyncKey(member),
    writeLine: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
  };
}

export async function main(): Promise<void> {
  await run(actionDeps());
}

// esbuild bundles this file to `dist/index.js`, the action's `main:` entry. Tests import `run`
// directly, so self-start only inside a real Actions job.
if (process.env.GITHUB_ACTIONS === "true" && process.env.VITEST === undefined) {
  void main();
}
