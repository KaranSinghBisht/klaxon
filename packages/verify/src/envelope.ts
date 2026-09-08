import { type Finding, finding } from "./errors.js";
import { txIdKey } from "./mirror/payments.js";
import type { TopicMessage } from "./mirror/topic.js";
import {
  EnvelopeSchema,
  type EnvelopeType,
  JwksBodySchema,
  RefusedBodySchema,
  ReleaseBodySchema,
  RevokeBodySchema,
  RotateBodySchema,
  UnrevokeBodySchema,
} from "./schema.js";
import { tsSeconds } from "./timestamp.js";

interface Anchored {
  consensusTimestamp: string;
  sequenceNumber: number;
  projectId: string;
  declaredTs: string;
}

/** A `released` or `refused` message: one witness answer to one paid request. */
export interface AttemptRecord extends Anchored {
  type: "released" | "refused";
  h: string;
  /** The commitment exactly as it appeared on the topic — `h` is recomputed from this. */
  commitment: unknown;
  jwt: string;
  sig: string;
  payTx: string;
  payTxKey: string;
  refusal?: { class: string; check: number; reason: string };
}

export interface RevokeRecord extends Anchored {
  type: "revoke";
  epoch: bigint;
  reason: string;
}

export interface UnrevokeRecord extends Anchored {
  type: "unrevoke";
  epoch: bigint;
}

export interface JwksRecord extends Anchored {
  type: "jwks";
  consensusSeconds: number;
  keys: Record<string, unknown>[];
}

export interface RotateRecord extends Anchored {
  type: "rotate";
  secret: string;
  fromGen: string;
  toGen: string;
}

export interface ParsedTopic {
  attempts: AttemptRecord[];
  revokes: RevokeRecord[];
  unrevokes: UnrevokeRecord[];
  jwks: JwksRecord[];
  rotates: RotateRecord[];
  /** Types we recognise but do not act on (`emergency`), kept for the JSON report. */
  other: { type: EnvelopeType; consensusTimestamp: string; projectId: string }[];
  findings: Finding[];
}

function toEpoch(value: number | string): bigint {
  return typeof value === "number" ? BigInt(value) : BigInt(value);
}

/** Turn reassembled topic JSON into the typed records the pairing and checks work on. */
export function parseEnvelopes(messages: readonly TopicMessage[]): ParsedTopic {
  const out: ParsedTopic = {
    attempts: [],
    revokes: [],
    unrevokes: [],
    jwks: [],
    rotates: [],
    other: [],
    findings: [],
  };

  for (const message of messages) {
    const envelope = EnvelopeSchema.safeParse(message.json);
    if (!envelope.success) {
      out.findings.push(
        finding(
          "MESSAGE_MALFORMED",
          `not a KLAXON envelope: ${envelope.error.issues[0]?.message ?? "invalid"}`,
          {
            at: message.consensusTimestamp,
          },
        ),
      );
      continue;
    }
    const base: Anchored = {
      consensusTimestamp: message.consensusTimestamp,
      sequenceNumber: message.sequenceNumber,
      projectId: envelope.data.project_id,
      declaredTs: envelope.data.ts,
    };
    const body = message.json;

    switch (envelope.data.type) {
      case "released":
      case "refused": {
        const release = ReleaseBodySchema.safeParse(body);
        if (!release.success) {
          out.findings.push(
            finding("MESSAGE_MALFORMED", `${envelope.data.type} message missing required fields`, {
              at: message.consensusTimestamp,
            }),
          );
          continue;
        }
        const record: AttemptRecord = {
          ...base,
          type: envelope.data.type,
          h: release.data.h,
          commitment: release.data.C,
          jwt: release.data.jwt,
          sig: release.data.sig,
          payTx: release.data.pay_tx,
          payTxKey: txIdKey(release.data.pay_tx),
        };
        if (envelope.data.type === "refused") {
          const refusal = RefusedBodySchema.safeParse(body);
          if (refusal.success) {
            record.refusal = {
              class: refusal.data.class,
              check: refusal.data.check,
              reason: refusal.data.reason,
            };
          }
        }
        out.attempts.push(record);
        break;
      }
      case "revoke": {
        const revoke = RevokeBodySchema.safeParse(body);
        if (!revoke.success) {
          out.findings.push(
            finding("MESSAGE_MALFORMED", "revoke message missing epoch/reason", {
              at: message.consensusTimestamp,
            }),
          );
          continue;
        }
        out.revokes.push({
          ...base,
          type: "revoke",
          epoch: toEpoch(revoke.data.epoch),
          reason: revoke.data.reason,
        });
        break;
      }
      case "unrevoke": {
        const unrevoke = UnrevokeBodySchema.safeParse(body);
        if (!unrevoke.success) {
          out.findings.push(
            finding("MESSAGE_MALFORMED", "unrevoke message missing epoch", {
              at: message.consensusTimestamp,
            }),
          );
          continue;
        }
        out.unrevokes.push({ ...base, type: "unrevoke", epoch: toEpoch(unrevoke.data.epoch) });
        break;
      }
      case "jwks": {
        const jwks = JwksBodySchema.safeParse(body);
        if (!jwks.success) {
          out.findings.push(
            finding("MESSAGE_MALFORMED", "jwks snapshot has no keys", {
              at: message.consensusTimestamp,
            }),
          );
          continue;
        }
        out.jwks.push({
          ...base,
          type: "jwks",
          consensusSeconds: tsSeconds(message.consensusTimestamp),
          keys: jwks.data.keys,
        });
        break;
      }
      case "rotate": {
        const rotate = RotateBodySchema.safeParse(body);
        if (!rotate.success) {
          out.findings.push(
            finding("MESSAGE_MALFORMED", "rotate message missing generations", {
              at: message.consensusTimestamp,
            }),
          );
          continue;
        }
        out.rotates.push({
          ...base,
          type: "rotate",
          secret: rotate.data.secret,
          fromGen: rotate.data.from_gen,
          toGen: rotate.data.to_gen,
        });
        break;
      }
      default:
        out.other.push({
          type: envelope.data.type,
          consensusTimestamp: message.consensusTimestamp,
          projectId: envelope.data.project_id,
        });
    }
  }

  out.jwks.sort((a, b) => a.consensusSeconds - b.consensusSeconds);
  return out;
}
