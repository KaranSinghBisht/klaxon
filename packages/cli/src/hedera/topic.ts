import { CliError } from "../errors.js";
import { type HederaOperator, loadSdk, operatorClient } from "./client.js";

export interface CreateTopicArgs extends HederaOperator {
  /** `klaxon:<project_id>` — one topic per project (PROTOCOL §7). */
  memo: string;
  /**
   * The witness's HCS submit public key, read from `GET /.well-known/klaxon.json` at `init`
   * (B §3.2). Only the witness may ever write to the topic; the laptop keeps the admin key.
   */
  submitKeyHex: string;
}

/** Injected so `init` can be tested without a Hedera account. */
export type TopicCreator = (a: CreateTopicArgs) => Promise<{ topicId: string }>;

export const createTopic: TopicCreator = async (a) => {
  const sdk = await loadSdk();
  let submitKey: import("@hashgraph/sdk").PublicKey;
  try {
    // The manifest carries a DER-hex public key; `fromString` accepts DER and raw for both curves.
    submitKey = sdk.PublicKey.fromString(a.submitKeyHex);
  } catch (cause) {
    throw new CliError("WITNESS_MALFORMED", "witness manifest submit_key is not a public key", {
      cause,
    });
  }
  const { client, key } = await operatorClient(a);
  try {
    const resp = await new sdk.TopicCreateTransaction()
      .setTopicMemo(a.memo)
      .setAdminKey(key.publicKey)
      .setSubmitKey(submitKey)
      .execute(client);
    const topicId = (await resp.getReceipt(client)).topicId;
    if (!topicId) throw new CliError("BAD_ARGUMENT", "Hedera returned no topic id");
    return { topicId: topicId.toString() };
  } finally {
    client.close();
  }
};
