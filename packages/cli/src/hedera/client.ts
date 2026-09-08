import { CliError } from "../errors.js";

export type HederaKeyType = "ecdsa" | "ed25519";
export type HederaNetwork = "testnet" | "mainnet" | "previewnet";

export interface HederaOperator {
  accountId: string;
  privateKey: string;
  keyType?: HederaKeyType;
  network?: HederaNetwork;
}

export function assertNetwork(value: string): HederaNetwork {
  if (value === "testnet" || value === "mainnet" || value === "previewnet") return value;
  throw new CliError("BAD_ARGUMENT", `unknown Hedera network ${value}`);
}

/**
 * `@klaxon/cli` is the only package allowed to load `@hashgraph/sdk` besides the witness (D33) —
 * the action must use `@x402/hedera`'s re-exports, and two SDK copies in one package break
 * `instanceof`. Loaded lazily so `klaxon --help` does not pay for a protobuf runtime.
 */
export async function loadSdk(): Promise<typeof import("@hashgraph/sdk")> {
  return import("@hashgraph/sdk");
}

/**
 * Hedera keys are ECDSA by default here: the Hedera portal issues ECDSA keys and `@x402/hedera`'s
 * own live suite assumes them for both client and facilitator (B §2.5). ED25519 stays available
 * for an operator whose account predates that.
 */
export function parsePrivateKey(
  sdk: typeof import("@hashgraph/sdk"),
  key: string,
  keyType: HederaKeyType = "ecdsa",
): import("@hashgraph/sdk").PrivateKey {
  try {
    return keyType === "ed25519"
      ? sdk.PrivateKey.fromStringED25519(key)
      : sdk.PrivateKey.fromStringECDSA(key);
  } catch (cause) {
    throw new CliError("BAD_ARGUMENT", `Hedera private key is not valid ${keyType}`, { cause });
  }
}

export async function operatorClient(
  o: HederaOperator,
): Promise<{ client: import("@hashgraph/sdk").Client; key: import("@hashgraph/sdk").PrivateKey }> {
  const sdk = await loadSdk();
  const key = parsePrivateKey(sdk, o.privateKey, o.keyType);
  const client = sdk.Client.forName(o.network ?? "testnet");
  try {
    client.setOperator(sdk.AccountId.fromString(o.accountId), key);
  } catch (cause) {
    client.close();
    throw new CliError("BAD_ARGUMENT", `Hedera operator account ${o.accountId} is not valid`, {
      cause,
    });
  }
  return { client, key };
}
