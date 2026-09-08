import { emergencyCommitment, emergencyMemo } from "../../../cli/src/share-b.js";
import type { CapturedMessage, CapturedPayment } from "./capture.js";

/**
 * A break-glass recovery, built by the code that really ships it.
 *
 * PROTOCOL §7's `emergency` is published by the operator's laptop — the second member of the
 * topic's 1-of-2 submit KeyList — so no witness run produces one and the witness harness cannot
 * emit it. `emergencyCommitment`/`emergencyMemo` come straight from the CLI rather than being
 * re-typed here, which makes this a real three-way check: the CLI's canonical object, the memo it
 * paid with, and `verify` rebuilding the same object from the message's own fields must all agree
 * on one hash.
 */
export interface EmergencyInput {
  projectId: string;
  topicId: string;
  secret: string;
  gen: string;
  /** The ISO instant the laptop stamped; it is inside the commitment, so it fixes `h`. */
  ts: string;
  /** SDK-form transaction id of the laptop's plain memo transfer to the witness account. */
  payTx: string;
  paymentConsensus: string;
  messageConsensus: string;
  sequenceNumber: string;
  amountTinybar: string;
}

export interface EmergencyRecovery {
  h: string;
  message: CapturedMessage;
  payment: CapturedPayment;
}

export function emergencyRecovery(input: EmergencyInput): EmergencyRecovery {
  const commitment = emergencyCommitment({
    project_id: input.projectId,
    secret: input.secret,
    gen: input.gen,
    ts: input.ts,
  });
  const h = emergencyMemo(commitment);
  return {
    h,
    message: {
      topicId: input.topicId,
      message: {
        klaxon: 1,
        type: "emergency",
        ts: input.ts,
        project_id: input.projectId,
        h,
        secret: input.secret,
        gen: input.gen,
        pay_tx: input.payTx,
      },
      sequenceNumber: input.sequenceNumber,
      consensusTimestamp: input.messageConsensus,
    },
    payment: {
      h,
      payTx: input.payTx,
      consensusTimestamp: input.paymentConsensus,
      amountTinybar: input.amountTinybar,
    },
  };
}
