import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";
import { verifyAtTime, verifyLive } from "../src/jwks.js";
import { mintJwt, oidcKeys, rotatedAwayJwks } from "./helpers/scenario.js";

const H = "1".repeat(64);
const PAID_AT = 1_788_848_310;

describe("JWT validation at the payment's consensus time", () => {
  it("verifies against the live key set", async () => {
    const keys = await oidcKeys("live-key");
    const jwt = await mintJwt(keys, PAID_AT, { h: H });
    const result = await verifyAtTime(jwt, H, PAID_AT, [], { remote: keys.jwks });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("live");
      expect(result.payload.repository_id).toBe("987654321");
    }
  });

  it("evaluates exp at consensus time, not at wall clock", async () => {
    const keys = await oidcKeys("live-key");
    // Minted for a payment far in the past; long expired by now, valid when it was spent.
    const oldPayment = 1_600_000_000;
    const jwt = await mintJwt(keys, oldPayment, { h: H }, 300);

    const now = await verifyLive(jwt, H, { remote: keys.jwks });
    expect(now.ok).toBe(false);
    if (!now.ok) expect(now.code).toBe("JWT_INVALID");

    const then = await verifyAtTime(jwt, H, oldPayment, [], { remote: keys.jwks });
    expect(then.ok).toBe(true);
  });

  it("rejects a token whose aud is not klaxon:h", async () => {
    const keys = await oidcKeys("live-key");
    const jwt = await mintJwt(keys, PAID_AT, { h: "9".repeat(64) });
    const result = await verifyAtTime(jwt, H, PAID_AT, [], { remote: keys.jwks });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("JWT_INVALID");
  });

  it("falls back to the newest snapshot at or before the payment once the kid is rotated away", async () => {
    const keys = await oidcKeys("rotated-key");
    const jwt = await mintJwt(keys, PAID_AT, { h: H });
    const stale = await oidcKeys("older-key");

    const snapshots = [
      // Too old to carry the kid, and superseded.
      {
        consensusSeconds: PAID_AT - 200_000,
        consensusTimestamp: "1788648310.0",
        keys: [stale.publicJwk as Record<string, unknown>],
      },
      // The covering snapshot.
      {
        consensusSeconds: PAID_AT - 3600,
        consensusTimestamp: "1788844710.0",
        keys: [keys.publicJwk as Record<string, unknown>],
      },
      // Published after the payment: must not be used.
      {
        consensusSeconds: PAID_AT + 3600,
        consensusTimestamp: "1788851910.0",
        keys: [keys.publicJwk as Record<string, unknown>],
      },
    ];

    const result = await verifyAtTime(jwt, H, PAID_AT, snapshots, { remote: rotatedAwayJwks });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("snapshot");
      expect(result.snapshotTimestamp).toBe("1788844710.0");
    }
  });

  it("reports JWKS_UNAVAILABLE when no snapshot covers the payment", async () => {
    const keys = await oidcKeys("rotated-key");
    const jwt = await mintJwt(keys, PAID_AT, { h: H });
    const other = await oidcKeys("someone-else");

    const noCover = await verifyAtTime(jwt, H, PAID_AT, [], { remote: rotatedAwayJwks });
    expect(noCover.ok).toBe(false);
    if (!noCover.ok) expect(noCover.code).toBe("JWKS_UNAVAILABLE");

    const wrongKid = await verifyAtTime(
      jwt,
      H,
      PAID_AT,
      [
        {
          consensusSeconds: PAID_AT - 10,
          consensusTimestamp: "1788848300.0",
          keys: [other.publicJwk as Record<string, unknown>],
        },
      ],
      { remote: rotatedAwayJwks },
    );
    expect(wrongKid.ok).toBe(false);
    if (!wrongKid.ok) expect(wrongKid.code).toBe("JWKS_UNAVAILABLE");

    const onlyLater = await verifyAtTime(
      jwt,
      H,
      PAID_AT,
      [
        {
          consensusSeconds: PAID_AT + 1,
          consensusTimestamp: "1788848311.0",
          keys: [keys.publicJwk as Record<string, unknown>],
        },
      ],
      { remote: rotatedAwayJwks },
    );
    expect(onlyLater.ok).toBe(false);
    if (!onlyLater.ok) expect(onlyLater.code).toBe("JWKS_UNAVAILABLE");
  });

  it("never launders a bad signature through a snapshot", async () => {
    const keys = await oidcKeys("rotated-key");
    const attacker = await oidcKeys("rotated-key"); // same kid, different key material
    const forged = await mintJwt(attacker, PAID_AT, { h: H });

    const result = await verifyAtTime(
      forged,
      H,
      PAID_AT,
      [
        {
          consensusSeconds: PAID_AT - 10,
          consensusTimestamp: "1788848300.0",
          keys: [keys.publicJwk as Record<string, unknown>],
        },
      ],
      { remote: rotatedAwayJwks },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("JWT_INVALID");
  });

  it("treats a wrong issuer as an invalid token, not a missing key", async () => {
    const keys = await oidcKeys("live-key");
    const jwt = await mintJwt(keys, PAID_AT, { h: H });
    const result = await verifyAtTime(jwt, H, PAID_AT, [], {
      remote: createLocalJWKSet({ keys: [keys.publicJwk] }),
      issuer: "https://not-github.example",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("JWT_INVALID");
  });
});
