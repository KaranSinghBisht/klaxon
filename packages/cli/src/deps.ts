import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { restoreWalletSyncKey, type WsekRestorer } from "@klaxon/core";
import type { TopicPublisher } from "./hedera/message.js";
import { publishTopicMessage } from "./hedera/message.js";
import type { TopicCreator } from "./hedera/topic.js";
import { createTopic } from "./hedera/topic.js";
import type { MemoTransfer } from "./hedera/transfer.js";
import { memoTransfer } from "./hedera/transfer.js";
import { execFileRunner, type WalletCliRunner } from "./wallet-cli/exec.js";
import { type KeychainReader, systemKeychain } from "./wallet-cli/keychain.js";

/**
 * Every edge of the CLI that touches a device, the OS keychain, the network or the clock lives
 * here, so a test can replace all of them at once and no test path can reach real hardware.
 */
export interface CliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  isTty: () => boolean;
  now: () => Date;
  keychain: KeychainReader;
  runWalletCli: WalletCliRunner;
  fetchImpl: typeof fetch;
  createTopic: TopicCreator;
  publishTopicMessage: TopicPublisher;
  memoTransfer: MemoTransfer;
  restoreWsek: WsekRestorer;
  readStdin: () => Promise<Buffer>;
  /** 32 hex characters — the ntfy topic name is the password (D29). */
  randomHex: (bytes: number) => string;
}

async function readAllStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function defaultDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
    isTty: () => Boolean(process.stdout.isTTY),
    now: () => new Date(),
    keychain: systemKeychain,
    runWalletCli: execFileRunner(process.env.WALLET_CLI_BIN),
    fetchImpl: fetch,
    createTopic,
    publishTopicMessage,
    memoTransfer,
    restoreWsek: (member) => restoreWalletSyncKey(member),
    readStdin: readAllStdin,
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
    ...overrides,
  };
}
