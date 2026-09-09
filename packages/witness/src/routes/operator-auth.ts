import { verifyOperatorRequest } from "@klaxon/core";
import type { FastifyRequest } from "fastify";

/**
 * PROTOCOL §2 — admin routes are authenticated with a dedicated **operator** key, generated at
 * `klaxon init` and held only on the operator's laptop. The signature is checked against
 * `projects.operator_pubkey`, registered at `init`.
 *
 * This replaces D27, which signed these requests with the LKRP member key. That key is a required
 * input of `klaxon/get`, so it is present in every protected job: anything sharing that
 * environment could sign `POST /shares` and be handed share B with no payment, no commitment and
 * no HCS record — exactly the silent theft the project exists to prevent. The member key now
 * authorises nothing on this surface.
 *
 * The signature covers method, path, timestamp and `sha256(raw body)`, so it cannot be replayed
 * onto another route or another body, and `|now − ts| ≤ 300 s` bounds the window.
 */
export interface OperatorAuthResult {
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

export function checkOperatorSignature(
  req: FastifyRequest,
  expectedPubHex: string,
  now: Date,
): OperatorAuthResult {
  try {
    const result = verifyOperatorRequest(
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
    return { ok: false, reason: "operator signature could not be checked" };
  }
}

/** The pubkey the caller claims, used to bootstrap `/projects` before a project row exists. */
export function claimedOperatorPubkey(req: FastifyRequest): string | undefined {
  const v = req.headers["x-klaxon-operator-pub"];
  return Array.isArray(v) ? v[0] : v;
}
