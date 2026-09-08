import { type HederaOperator, loadSdk, operatorClient } from "./client.js";

export interface MemoTransferArgs extends HederaOperator {
  to: string;
  /** Tinybars, as a string — the same units the witness's x402 `price.amount` is quoted in. */
  amountTinybars: string;
  /** The commitment hash. This is the whole point: it is what makes the recovery public. */
  memo: string;
}

export interface MemoTransferResult {
  payTx: string;
  consensusTimestamp: string;
}

/** Injected so `emergency` can be tested without paying anything. */
export type MemoTransfer = (a: MemoTransferArgs) => Promise<MemoTransferResult>;

/**
 * A plain `TransferTransaction` with `setTransactionMemo(h)` — no x402, no facilitator. `emergency`
 * runs on the operator's laptop with its own Hedera key, and the memo is what leaves the same
 * public trace a normal release would: the secret was opened, and here is when.
 */
export const memoTransfer: MemoTransfer = async (a) => {
  const sdk = await loadSdk();
  const { client } = await operatorClient(a);
  try {
    const amount = BigInt(a.amountTinybars);
    const from = sdk.AccountId.fromString(a.accountId);
    const to = sdk.AccountId.fromString(a.to);
    const resp = await new sdk.TransferTransaction()
      .addHbarTransfer(from, sdk.Hbar.fromTinybars((-amount).toString()))
      .addHbarTransfer(to, sdk.Hbar.fromTinybars(amount.toString()))
      .setTransactionMemo(a.memo)
      .execute(client);
    // D12: receipts carry no consensus timestamp; the record does.
    const record = await resp.getRecord(client);
    return {
      payTx: record.transactionId.toString(),
      consensusTimestamp: record.consensusTimestamp.toString(),
    };
  } finally {
    client.close();
  }
};
