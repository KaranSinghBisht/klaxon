/**
 * The consensus log. One topic per project, submit key = the witness, so Hedera itself proves
 * authorship and the envelope carries no signature field (D35).
 */
export interface HcsPublished {
  /** Decimal string — `ReleaseOk.hcs.sequence_number` is a string on the wire. */
  sequenceNumber: string;
  /** `seconds.nanos`, from `getRecord()`; a receipt does not carry it (D12). */
  consensusTimestamp: string;
}

export interface HcsPort {
  /** The witness's submit public key, DER hex — published in the manifest so `init` can set it. */
  readonly submitKeyDer: string;
  publish(topicId: string, message: unknown): Promise<HcsPublished>;
}
