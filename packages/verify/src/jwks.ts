import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
/** The same tolerance the witness applies (D22), so the two cannot disagree on skew alone. */
export const CLOCK_TOLERANCE_SECONDS = 60;

export interface JwksSnapshot {
  consensusSeconds: number;
  consensusTimestamp: string;
  keys: Record<string, unknown>[];
}

export type JwtSource = "live" | "snapshot";

export type JwtCheck =
  | { ok: true; payload: JWTPayload; source: JwtSource; snapshotTimestamp?: string }
  | { ok: false; code: "JWT_INVALID" | "JWKS_UNAVAILABLE"; reason: string };

export interface JwksOptions {
  /** Injected in tests so no unit test touches GitHub. */
  remote?: JWTVerifyGetKey;
  issuer?: string;
  clockTolerance?: number;
}

export function createGithubJwks(): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(GITHUB_JWKS_URL), {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
}

/**
 * Errors that mean "this key set could not answer", as opposed to "this token is bad". Only the
 * former may fall back to a snapshot — falling back on a signature failure would let a witness
 * launder a forged token through its own published key list.
 */
const LOOKUP_FAILURE_CODES = new Set([
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_TIMEOUT",
  "ERR_JWKS_INVALID",
]);

function isKeyLookupFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && LOOKUP_FAILURE_CODES.has(code)) return true;
  // A transport failure reaching github.com arrives as a plain TypeError from fetch.
  return error instanceof TypeError;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Live JWKS at wall-clock time — the path the witness itself uses on a fresh token. */
export async function verifyLive(
  jwt: string,
  h: string,
  options: JwksOptions = {},
): Promise<JwtCheck> {
  const remote = options.remote ?? createGithubJwks();
  try {
    const { payload } = await jwtVerify(jwt, remote, {
      issuer: options.issuer ?? GITHUB_ISSUER,
      audience: `klaxon:${h}`,
      algorithms: ["RS256"],
      clockTolerance: options.clockTolerance ?? CLOCK_TOLERANCE_SECONDS,
    });
    return { ok: true, payload, source: "live" };
  } catch (error) {
    return {
      ok: false,
      code: isKeyLookupFailure(error) ? "JWKS_UNAVAILABLE" : "JWT_INVALID",
      reason: reasonOf(error),
    };
  }
}

/**
 * Validate a token as of the moment its payment reached consensus (D22, A §6.5).
 *
 * `currentDate` is the honest way to evaluate `exp`/`nbf`: the question is whether the token was
 * good when it was spent, not whether it is good now. GitHub rotates its JWKS, so a token from
 * last week may name a `kid` that no longer exists; the witness's daily `jwks` snapshots cover
 * that, with the trust boundary stated plainly in the report — a snapshot is only as good as the
 * witness was on the day it published it, before it knew which token it would later want to forge.
 */
export async function verifyAtTime(
  jwt: string,
  h: string,
  consensusSeconds: number,
  snapshots: readonly JwksSnapshot[],
  options: JwksOptions = {},
): Promise<JwtCheck> {
  const issuer = options.issuer ?? GITHUB_ISSUER;
  const clockTolerance = options.clockTolerance ?? CLOCK_TOLERANCE_SECONDS;
  const currentDate = new Date(consensusSeconds * 1000);
  const remote = options.remote ?? createGithubJwks();

  let liveError: unknown;
  try {
    const { payload } = await jwtVerify(jwt, remote, {
      issuer,
      audience: `klaxon:${h}`,
      algorithms: ["RS256"],
      clockTolerance,
      currentDate,
    });
    return { ok: true, payload, source: "live" };
  } catch (error) {
    if (!isKeyLookupFailure(error)) {
      return { ok: false, code: "JWT_INVALID", reason: reasonOf(error) };
    }
    liveError = error;
  }

  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(jwt).kid;
  } catch (error) {
    return { ok: false, code: "JWT_INVALID", reason: reasonOf(error) };
  }

  const covering = snapshots
    .filter((s) => s.consensusSeconds <= consensusSeconds)
    .sort((a, b) => a.consensusSeconds - b.consensusSeconds);
  const snapshot = covering.findLast((s) => s.keys.some((k) => k.kid === kid));
  if (!snapshot) {
    const newest = covering[covering.length - 1];
    const detail = newest
      ? `no snapshot at or before ${consensusSeconds} carries kid ${kid ?? "(none)"} (newest covering snapshot ${newest.consensusTimestamp})`
      : `no jwks snapshot at or before ${consensusSeconds}`;
    return {
      ok: false,
      code: "JWKS_UNAVAILABLE",
      reason: `${detail}; live: ${reasonOf(liveError)}`,
    };
  }

  try {
    const local = createLocalJWKSet({ keys: snapshot.keys } as unknown as JSONWebKeySet);
    const { payload } = await jwtVerify(jwt, local, {
      issuer,
      audience: `klaxon:${h}`,
      algorithms: ["RS256"],
      clockTolerance,
      currentDate,
    });
    return {
      ok: true,
      payload,
      source: "snapshot",
      snapshotTimestamp: snapshot.consensusTimestamp,
    };
  } catch (error) {
    return {
      ok: false,
      code: isKeyLookupFailure(error) ? "JWKS_UNAVAILABLE" : "JWT_INVALID",
      reason: reasonOf(error),
    };
  }
}

/** Claims read without verifying the signature — used for `aud` and the §0.5 claim cross-check. */
export function claimsOf(jwt: string): JWTPayload | null {
  try {
    return decodeJwt(jwt);
  } catch {
    return null;
  }
}
