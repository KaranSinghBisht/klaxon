import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commitmentHash, PROBE_AUDIENCE } from "../src/commitment.js";
import { eciesSeal } from "../src/crypto/ecies.js";
import { verifyCommitmentSig } from "../src/crypto/ephemeral.js";
import { KlaxonError } from "../src/errors.js";
import { deriveProjectId } from "../src/project.js";
import { addSecret } from "../src/release/add.js";
import { getSecret, NO_ENVIRONMENT } from "../src/release/get.js";
import type { ReleaseRequestBody, ReleaseTransport } from "../src/release/ports.js";
import type { KlaxonMember } from "../src/schema.js";

const wsek = randomBytes(32).toString("hex");
const member: KlaxonMember = {
  v: 1,
  rootId: "root",
  applicationPath: "m/0'/16'/0'",
  applicationId: 17,
  privatekey: "ab".repeat(32),
  pubkey: `02${"cd".repeat(32)}`,
};
const pid = deriveProjectId("123456789", "root");

function fakeJwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256", kid: "k" })}.${b(claims)}.${b("sig")}`;
}

/** A fake witness: derives nothing, just answers with the B it was given, sealed to the runner's key. */
function fakeWitness(
  shareB: Uint8Array,
  opts: { refuse?: boolean; wrongB?: boolean } = {},
): ReleaseTransport & {
  seen: ReleaseRequestBody[];
} {
  const seen: ReleaseRequestBody[] = [];
  return {
    seen,
    async release(h, body) {
      seen.push(body);
      if (commitmentHash(body.C) !== h) throw new Error("test: h mismatch");
      if (!verifyCommitmentSig(body.C.ephemeral_pub, h, body.sig)) throw new Error("test: bad sig");
      if (opts.refuse) {
        return {
          status: 403,
          payTx: "0.0.1@1.2",
          body: { ok: false, h, class: "policy", check: 3, reason: "no environment" },
        };
      }
      const b = opts.wrongB ? randomBytes(32) : shareB;
      return {
        status: 200,
        payTx: "0.0.1@1.2",
        body: {
          ok: true,
          h,
          share_b: eciesSeal(body.C.ephemeral_pub.enc, h, b),
          hcs: { sequence_number: "1", consensus_timestamp: "1.0" },
        },
      };
    },
  };
}

const oidcFor = (env?: string) => async (aud: string) =>
  fakeJwt({
    aud,
    repository_id: "123456789",
    run_id: "481",
    run_attempt: "1",
    ...(env ? { environment: env } : {}),
  });

describe("add → get round trip", () => {
  it("recovers the plaintext through a witness that holds only B", async () => {
    const shareB = randomBytes(32);
    const plaintext = Buffer.from(`0x7f3a${"ab".repeat(30)}`);
    const enc = addSecret({
      projectId: pid,
      secret: "DEPLOYER_PRIVATE_KEY",
      gen: "1",
      plaintext,
      wsek,
      shareB,
    });
    const witness = fakeWitness(shareB);
    const oidcCalls: string[] = [];
    const oidc = async (aud: string) => {
      oidcCalls.push(aud);
      return oidcFor("production")(aud);
    };
    const r = await getSecret({ enc, member, oidc, transport: witness, restore: async () => wsek });
    expect(r.secret).toEqual(plaintext);
    expect(r.payTx).toBe("0.0.1@1.2");
    // D18: a probe token first, then the real token whose aud is the commitment hash.
    expect(oidcCalls[0]).toBe(PROBE_AUDIENCE);
    expect(oidcCalls[1]).toBe(`klaxon:${r.h}`);
    expect(witness.seen[0]?.C.environment).toBe("production");
    expect(witness.seen[0]?.C.run_id).toBe("481");
  });

  it("still pays and records when the job has no environment — then surfaces the refusal", async () => {
    const shareB = randomBytes(32);
    const enc = addSecret({
      projectId: pid,
      secret: "DEPLOYER_PRIVATE_KEY",
      gen: "1",
      plaintext: Buffer.from("s"),
      wsek,
      shareB,
    });
    const witness = fakeWitness(shareB, { refuse: true });
    await expect(
      getSecret({
        enc,
        member,
        oidc: oidcFor(undefined),
        transport: witness,
        restore: async () => wsek,
      }),
    ).rejects.toThrow(/refused \(policy, check 3\)/);
    expect(witness.seen[0]?.C.environment).toBe(NO_ENVIRONMENT);
  });

  it("rejects a witness that returns the wrong share", async () => {
    const shareB = randomBytes(32);
    const enc = addSecret({
      projectId: pid,
      secret: "X",
      gen: "1",
      plaintext: Buffer.from("s"),
      wsek,
      shareB,
    });
    await expect(
      getSecret({
        enc,
        member,
        oidc: oidcFor("production"),
        transport: fakeWitness(shareB, { wrongB: true }),
        restore: async () => wsek,
      }),
    ).rejects.toThrow(KlaxonError);
  });

  it("a gen-N .enc is inert against a gen-N+1 B", async () => {
    const b1 = randomBytes(32);
    const b2 = randomBytes(32);
    const enc1 = addSecret({
      projectId: pid,
      secret: "X",
      gen: "1",
      plaintext: Buffer.from("s"),
      wsek,
      shareB: b1,
    });
    await expect(
      getSecret({
        enc: enc1,
        member,
        oidc: oidcFor("production"),
        transport: fakeWitness(b2),
        restore: async () => wsek,
      }),
    ).rejects.toThrow(/does not match b_hash/);
  });
});
