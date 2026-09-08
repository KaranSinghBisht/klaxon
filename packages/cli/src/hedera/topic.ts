import { CliError } from "../errors.js";
import { type HederaOperator, loadSdk, operatorClient } from "./client.js";

export interface CreateTopicArgs extends HederaOperator {
  /** `klaxon:<project_id>` — one topic per project (PROTOCOL §7). */
  memo: string;
  /**
   * The witness's HCS submit public key, read from `GET /.well-known/klaxon.json` at `init`
   * (B §3.2).
   */
  submitKeyHex: string;
}

/** Injected so `init` can be tested without a Hedera account. */
export type TopicCreator = (a: CreateTopicArgs) => Promise<{ topicId: string }>;

/**
 * The submit key is a 1-of-2 `KeyList` over {witness, operator laptop} (PROTOCOL §7). The witness
 * writes every `released`/`refused`; the laptop writes the one message the witness cannot — the
 * `emergency` record of a break-glass recovery it was not involved in. Threshold 1 means neither
 * key needs the other, and no third party can write at all.
 */
export function submitKeyList(
  sdk: typeof import("@hashgraph/sdk"),
  witnessKeyHex: string,
  laptopKey: import("@hashgraph/sdk").PublicKey,
): import("@hashgraph/sdk").KeyList {
  let witnessKey: import("@hashgraph/sdk").PublicKey;
  try {
    // The manifest carries a DER-hex public key; `fromString` accepts DER and raw for both curves.
    witnessKey = sdk.PublicKey.fromString(witnessKeyHex);
  } catch (cause) {
    throw new CliError("WITNESS_MALFORMED", "witness manifest submit_key is not a public key", {
      cause,
    });
  }
  return new sdk.KeyList([witnessKey, laptopKey]).setThreshold(1);
}

export const createTopic: TopicCreator = async (a) => {
  const sdk = await loadSdk();
  const { client, key } = await operatorClient(a);
  try {
    const resp = await new sdk.TopicCreateTransaction()
      .setTopicMemo(a.memo)
      .setAdminKey(key.publicKey)
      .setSubmitKey(submitKeyList(sdk, a.submitKeyHex, key.publicKey))
      .execute(client);
    const topicId = (await resp.getReceipt(client)).topicId;
    if (!topicId) throw new CliError("BAD_ARGUMENT", "Hedera returned no topic id");
    return { topicId: topicId.toString() };
  } finally {
    client.close();
  }
};
