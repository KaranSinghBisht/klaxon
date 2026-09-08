import { verifyMemberRequest } from "@klaxon/core";
import type { FastifyRequest } from "fastify";

/**
 * D27 / PROTOCOL §2 — admin routes are authenticated with the LKRP **member** private key, the one
 * the Ledger root already issued. No operator API key, no new secret on the witness: the signature
 * is checked against `projects.member_pubkey`, which was registered at `init`.
 *
 * The signature covers method, path, timestamp and `sha256(raw body)`, so it cannot be replayed
 * onto another route or another body, and `|now − ts| ≤ 300 s` bounds the window.
 */
export interface MemberAuthResult {
  ok: boolean;
  reason?: string;
}

function headerMap(req: FastifyRequest): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

/** The signed path is the pathname only — a query string is not part of the message. */
export function requestPath(req: FastifyRequest): string {
  return new URL(req.url, "http://witness.invalid").pathname;
}

export function rawBodyOf(req: FastifyRequest): Buffer {
  return req.rawBody ?? Buffer.alloc(0);
}

export function checkMemberSignature(
  req: FastifyRequest,
  expectedPubHex: string,
  now: Date,
): MemberAuthResult {
  try {
    const result = verifyMemberRequest(
      expectedPubHex,
      headerMap(req),
      req.method,
      requestPath(req),
      rawBodyOf(req),
      now,
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } catch {
    // A malformed public key or signature encoding throws in core; that is still just a bad
    // request, and the detail stays out of the response.
    return { ok: false, reason: "member signature could not be checked" };
  }
}

/** The pubkey the caller claims, used to bootstrap `/projects` before a project row exists. */
export function claimedMemberPubkey(req: FastifyRequest): string | undefined {
  const v = req.headers["x-klaxon-member-pub"];
  return Array.isArray(v) ? v[0] : v;
}
