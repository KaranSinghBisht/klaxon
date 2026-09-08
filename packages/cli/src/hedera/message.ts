import { type HederaOperator, loadSdk, operatorClient } from "./client.js";

export interface PublishMessageArgs extends HederaOperator {
  topicId: string;
  message: string;
}

export interface PublishMessageResult {
  sequenceNumber: string;
  consensusTimestamp: string;
  transactionId: string;
}

/** Injected so `emergency` can be tested without touching a topic. */
export type TopicPublisher = (a: PublishMessageArgs) => Promise<PublishMessageResult>;

/**
 * The laptop's half of the topic's 1-of-2 submit `KeyList` (PROTOCOL §7). Only `emergency` uses
 * it — every other message on the topic is the witness's.
 */
export const publishTopicMessage: TopicPublisher = async (a) => {
  const sdk = await loadSdk();
  const { client } = await operatorClient(a);
  try {
    const resp = await new sdk.TopicMessageSubmitTransaction()
      .setTopicId(a.topicId)
      .setMessage(a.message)
      .execute(client);
    // D12: receipts carry no consensus timestamp; the record does.
    const record = await resp.getRecord(client);
    return {
      sequenceNumber: (record.receipt.topicSequenceNumber ?? "").toString(),
      consensusTimestamp: record.consensusTimestamp.toString(),
      transactionId: record.transactionId.toString(),
    };
  } finally {
    client.close();
  }
};
