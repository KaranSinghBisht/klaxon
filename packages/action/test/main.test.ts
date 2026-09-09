import {
  buildEncFile,
  clearSecretRegistry,
  deriveProjectId,
  type GetSecretOptions,
  type GetSecretResult,
  type ReleaseRefused,
  serializeEncFile,
} from "@klaxon/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type ActionsCoreLike, type RunDeps, run, type TransportOptions } from "../src/main.js";
import type { KlaxonReleaseTransport } from "../src/transport.js";

const H = `8f2e${"a3".repeat(30)}`;
const PLAINTEXT = `0x7f3a${"ab".repeat(30)}`;
const PROJECT_ID = deriveProjectId("123456789", "root");

const MEMBER = JSON.stringify({
  v: 1,
  rootId: "root",
  applicationPath: "m/0'/16'/0'",
  applicationId: 17,
  privatekey: "ab".repeat(32),
  pubkey: `02${"cd".repeat(32)}`,
});

const ENC = serializeEncFile(
  buildEncFile({
    projectId: PROJECT_ID,
    secret: "DEPLOYER_PRIVATE_KEY",
    gen: "1",
    ct: {
      iv: Buffer.alloc(12).toString("base64url"),
      ct: Buffer.from("ciphertext").toString("base64url"),
      tag: Buffer.alloc(16).toString("base64url"),
    },
    aCt: Buffer.alloc(48, 7),
    bHash: "cd".repeat(32),
    createdAt: new Date("2026-09-08T00:00:00.000Z"),
  }),
);

const INPUTS: Record<string, string> = {
  secret: "DEPLOYER_PRIVATE_KEY",
  witness: "https://klaxon-witness.fly.dev",
  member: MEMBER,
  "pay-account": "0.0.9876543",
  "pay-key": "0x".concat("11".repeat(32)),
  "max-tinybars": "200000",
};

interface Recorder {
  core: ActionsCoreLike;
  order: string[];
  failed: string[];
  info: string[];
  state: Record<string, string>;
  audiences: string[];
  outputs: Record<string, string>;
}

function recorder(inputs: Record<string, string> = INPUTS): Recorder {
  const r: Recorder = {
    order: [],
    failed: [],
    info: [],
    state: {},
    audiences: [],
    outputs: {},
    core: {
      getInput(name, options) {
        const v = inputs[name] ?? "";
        if (options?.required && v === "") throw new Error(`Input required: ${name}`);
        return v;
      },
      setSecret: () => r.order.push("setSecret"),
      setOutput: (name, value) => {
        r.order.push("setOutput");
        r.outputs[name] = value;
      },
      setFailed: (m) => r.failed.push(m),
      info: (m) => r.info.push(m),
      saveState: (name, value) => {
        r.state[name] = value;
      },
      getIDToken: async (audience) => {
        r.audiences.push(audience ?? "");
        return `jwt-for-${audience ?? ""}`;
      },
    },
  };
  return r;
}

function fakeTransport(refusal: ReleaseRefused | null = null): KlaxonReleaseTransport {
  return {
    lastRefusal: () => refusal,
    release: async () => {
      throw new Error("the fake getSecret never calls the transport");
    },
  };
}

const RELEASED: GetSecretResult = {
  secret: Buffer.from(PLAINTEXT, "utf8"),
  h: H,
  payTx: "0.0.1@1.2",
  hcs: { sequence_number: "42", consensus_timestamp: "1788848437.031176249" },
  timings: { restoreMs: 1, releaseMs: 2 },
};

function deps(r: Recorder, over: Partial<RunDeps> = {}): RunDeps {
  const base: RunDeps = {
    core: r.core,
    readEnc: () => ENC,
    buildTransport: async (_o: TransportOptions) => fakeTransport(),
    getSecret: async (_o: GetSecretOptions) => RELEASED,
    restore: async () => "ff".repeat(32),
    writeLine: () => {},
  };
  return { ...base, ...over };
}

describe("run", () => {
  beforeEach(() => {
    clearSecretRegistry();
  });

  it("masks the value before it can reach any sink, then publishes it as an output", async () => {
    const r = recorder();
    const masks: string[] = [];
    await run(deps(r, { writeLine: (l) => masks.push(l) }));

    expect(r.failed).toEqual([]);
    expect(r.order).toEqual(["setSecret", "setOutput"]);
    expect(r.order.indexOf("setSecret")).toBeLessThan(r.order.indexOf("setOutput"));
    expect(r.outputs.value).toBe(PLAINTEXT);
    // `emitGithubMasks` runs the moment `getSecret` returns, so every derived encoding is
    // registered with the runner's redactor before the value reaches `setOutput`.
    expect(masks.every((l) => l.startsWith("::add-mask::"))).toBe(true);
  });

  it("emits the masks for material already derived when the release fails part-way", async () => {
    const r = recorder();
    const masks: string[] = [];
    const { registerSecretMaterial } = await import("@klaxon/core");
    const shareA = Buffer.alloc(32, 9);

    await run(
      deps(r, {
        writeLine: (l) => masks.push(l),
        getSecret: async () => {
          // What `getSecret` really does: share A is decrypted and registered long before the
          // witness can refuse, so a throw after that point must not leave it unmasked.
          registerSecretMaterial(shareA);
          throw new Error("release refused");
        },
      }),
    );

    expect(r.failed).toHaveLength(1);
    expect(masks).toContain(`::add-mask::${shareA.toString("hex")}`);
    expect(masks).toContain(`::add-mask::${shareA.toString("base64url")}`);
    // Nothing was released, so nothing reached a sink either.
    expect(r.order).toEqual([]);
  });

  it("hands getSecret an oidc callback wired to core.getIDToken", async () => {
    const r = recorder();
    const seen: GetSecretOptions[] = [];
    await run(
      deps(r, {
        getSecret: async (o) => {
          seen.push(o);
          return RELEASED;
        },
      }),
    );

    const options = seen[0];
    expect(options).toBeDefined();
    expect(options?.enc.secret).toBe("DEPLOYER_PRIVATE_KEY");
    expect(options?.member.rootId).toBe("root");
    await expect(options?.oidc("klaxon:probe")).resolves.toBe("jwt-for-klaxon:probe");
    expect(r.audiences).toEqual(["klaxon:probe"]);
  });

  it("saves only public values for the post step and logs the release line", async () => {
    const r = recorder();
    await run(deps(r));

    expect(r.state.klaxon_commitment).toBe(H);
    expect(r.state.klaxon_pay_tx).toBe("0.0.1@1.2");
    // The plaintext is never persisted — the post step has nothing to re-mask, by design.
    expect(Object.values(r.state)).not.toContain(PLAINTEXT);
    expect(r.info[0]).toBe(
      `KLAXON: DEPLOYER_PRIVATE_KEY released · commitment ${H} · paid 0.0.1@1.2 · hcs #42`,
    );
  });

  it("rewrites the id-token error into the permission the job is missing", async () => {
    const r = recorder();
    await run(
      deps(r, {
        getSecret: async () => {
          throw new Error("Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable");
        },
      }),
    );
    expect(r.failed[0]).toMatch(/id-token: write/);
    expect(r.order).toEqual([]);
  });

  it("reports a refusal with its class, check, reason and commitment", async () => {
    const r = recorder();
    const refusal: ReleaseRefused = {
      ok: false,
      h: H,
      class: "policy",
      check: 5,
      reason: "deploy job uses an unpinned action",
    };
    await run(
      deps(r, {
        buildTransport: async () => fakeTransport(refusal),
        getSecret: async () => {
          throw new Error("release refused");
        },
      }),
    );
    expect(r.failed[0]).toContain("policy");
    expect(r.failed[0]).toContain("check 5");
    expect(r.failed[0]).toContain("deploy job uses an unpinned action");
    expect(r.failed[0]).toContain(H);
    expect(r.failed[0]).toContain("revoked");
  });

  it("cites the HCS record and the revocation the witness reported", async () => {
    const r = recorder();
    await run(
      deps(r, {
        buildTransport: async () =>
          fakeTransport({
            ok: false,
            h: H,
            class: "policy",
            check: 4,
            reason: "job has no environment",
            hcs: { sequence_number: "4821", consensus_timestamp: "1788848437.031176249" },
            revoked: true,
          }),
        getSecret: async () => {
          throw new Error("release refused");
        },
      }),
    );
    expect(r.failed[0]).toBe(
      `KLAXON: refused (policy, check 4): job has no environment · commitment ${H} · on the record: HCS #4821 · project revoked`,
    );
  });

  it("does not claim a revocation the witness explicitly denied", async () => {
    const r = recorder();
    await run(
      deps(r, {
        buildTransport: async () =>
          fakeTransport({
            ok: false,
            h: H,
            class: "policy",
            check: 7,
            reason: "release budget exhausted",
            hcs: { sequence_number: "4822", consensus_timestamp: "1788848438.0" },
            revoked: false,
          }),
        getSecret: async () => {
          throw new Error("release refused");
        },
      }),
    );
    expect(r.failed[0]).toContain("HCS #4822");
    expect(r.failed[0]).not.toContain("revoked");
  });

  it("tells the operator to retry when the witness fails closed", async () => {
    const r = recorder();
    await run(
      deps(r, {
        buildTransport: async () =>
          fakeTransport({ ok: false, h: H, class: "infra", check: 1, reason: "mirror node 503" }),
        getSecret: async () => {
          throw new Error("release refused");
        },
      }),
    );
    expect(r.failed[0]).toMatch(/fail closed, retry/);
    expect(r.failed[0]).not.toMatch(/revoked/);
    // Infra never reaches HCS, so there is no record to cite.
    expect(r.failed[0]).not.toMatch(/HCS/);
  });

  it("never prints the share when the witness returns a bad one", async () => {
    const r = recorder();
    const { KlaxonError } = await import("@klaxon/core");
    await run(
      deps(r, {
        getSecret: async () => {
          throw new KlaxonError(
            "WITNESS_BAD_SHARE",
            "witness returned a share that does not match b_hash",
          );
        },
      }),
    );
    expect(r.failed[0]).toBe("KLAXON: witness returned a bad share");
    expect(r.failed[0]).not.toMatch(/b_hash/);
  });

  it("says which file is missing when the .enc is not committed", async () => {
    const r = recorder();
    await run(
      deps(r, {
        readEnc: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(r.failed[0]).toMatch(/\.klaxon\/DEPLOYER_PRIVATE_KEY\.enc/);
  });
});
