import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compressedPubkeyHex, generateOperatorKey, type OperatorKey } from "@klaxon/core";
import { CliError } from "./errors.js";

const HEX32 = /^[0-9a-f]{64}$/;

/**
 * The operator key lives in one 0600 file on the laptop and nowhere else. It is not in the OS
 * keychain because, unlike the member key, nothing else on the machine issues or consumes it —
 * and it is emphatically not the member key, because that one ships to every runner as an action
 * input. See `packages/core/src/auth/operator-sign.ts` for what that mistake cost.
 */
export function loadOperatorKey(file: string): OperatorKey {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new CliError(
      "OPERATOR_KEY_MISSING",
      `no operator key at ${file} — run \`klaxon init\` on this machine, or copy the file across from the laptop that ran it`,
      { cause },
    );
  }
  const privatekey = text.trim().toLowerCase();
  if (!HEX32.test(privatekey)) {
    throw new CliError("OPERATOR_KEY_MALFORMED", `${file} is not 32 bytes of hex`);
  }
  return { privatekey, pubkey: compressedPubkeyHex(privatekey) };
}

/** Creates the key on first `init` and never overwrites one: a lost operator key is a re-register. */
export function loadOrCreateOperatorKey(file: string): { key: OperatorKey; created: boolean } {
  if (existsSync(file)) return { key: loadOperatorKey(file), created: false };
  const key = generateOperatorKey();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${key.privatekey}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
  return { key, created: true };
}
