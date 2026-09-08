import type { Commitment } from "@klaxon/core";

/**
 * PROTOCOL §7 / D35 — the frozen envelope. `verify` parses these from the mirror node, so the
 * shape does not change without changing `verify` too.
 *
 * There is no witness signature field: the topic's submit key **is** the witness, so Hedera
 * already proves authorship. A `refused` carries the same `C`, `jwt`, `sig` and `pay_tx` as a
 * `released` would, which is what lets `verify` pair a refusal to its payment.
 */
export interface EnvelopeBase {
  klaxon: 1;
  type: "released" | "refused" | "rotate" | "revoke" | "unrevoke" | "jwks" | "emergency";
  ts: string;
  project_id: string;
}

export interface ReleasedEnvelope extends EnvelopeBase {
  type: "released";
  h: string;
  C: Commitment;
  jwt: string;
  sig: string;
  pay_tx: string;
}

export interface RefusedEnvelope extends EnvelopeBase {
  type: "refused";
  h: string;
  C: Commitment;
  jwt: string;
  sig: string;
  pay_tx: string;
  class: "auth" | "policy";
  check: number;
  reason: string;
}

export interface RotateEnvelope extends EnvelopeBase {
  type: "rotate";
  secret: string;
  from_gen: string;
  to_gen: string;
}

export interface RevokeEnvelope extends EnvelopeBase {
  type: "revoke";
  reason: string;
  epoch: string;
}

export interface UnrevokeEnvelope extends EnvelopeBase {
  type: "unrevoke";
  epoch: string;
  sepolia_tx: string;
}

export interface JwksEnvelope extends EnvelopeBase {
  type: "jwks";
  keys: unknown[];
}

export type HcsEnvelope =
  | ReleasedEnvelope
  | RefusedEnvelope
  | RotateEnvelope
  | RevokeEnvelope
  | UnrevokeEnvelope
  | JwksEnvelope;

export function releasedEnvelope(args: {
  ts: string;
  projectId: string;
  h: string;
  C: Commitment;
  jwt: string;
  sig: string;
  payTx: string;
}): ReleasedEnvelope {
  return {
    klaxon: 1,
    type: "released",
    ts: args.ts,
    project_id: args.projectId,
    h: args.h,
    C: args.C,
    jwt: args.jwt,
    sig: args.sig,
    pay_tx: args.payTx,
  };
}

export function refusedEnvelope(args: {
  ts: string;
  projectId: string;
  h: string;
  C: Commitment;
  jwt: string;
  sig: string;
  payTx: string;
  class: "auth" | "policy";
  check: number;
  reason: string;
}): RefusedEnvelope {
  return {
    klaxon: 1,
    type: "refused",
    ts: args.ts,
    project_id: args.projectId,
    h: args.h,
    C: args.C,
    jwt: args.jwt,
    sig: args.sig,
    pay_tx: args.payTx,
    class: args.class,
    check: args.check,
    reason: args.reason,
  };
}

export function rotateEnvelope(args: {
  ts: string;
  projectId: string;
  secret: string;
  fromGen: string;
  toGen: string;
}): RotateEnvelope {
  return {
    klaxon: 1,
    type: "rotate",
    ts: args.ts,
    project_id: args.projectId,
    secret: args.secret,
    from_gen: args.fromGen,
    to_gen: args.toGen,
  };
}

export function revokeEnvelope(args: {
  ts: string;
  projectId: string;
  reason: string;
  epoch: number;
}): RevokeEnvelope {
  return {
    klaxon: 1,
    type: "revoke",
    ts: args.ts,
    project_id: args.projectId,
    reason: args.reason,
    epoch: String(args.epoch),
  };
}

export function unrevokeEnvelope(args: {
  ts: string;
  projectId: string;
  epoch: number;
  sepoliaTx: string;
}): UnrevokeEnvelope {
  return {
    klaxon: 1,
    type: "unrevoke",
    ts: args.ts,
    project_id: args.projectId,
    epoch: String(args.epoch),
    sepolia_tx: args.sepoliaTx,
  };
}

export function jwksEnvelope(args: {
  ts: string;
  projectId: string;
  keys: unknown[];
}): JwksEnvelope {
  return { klaxon: 1, type: "jwks", ts: args.ts, project_id: args.projectId, keys: args.keys };
}
