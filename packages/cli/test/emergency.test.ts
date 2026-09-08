import { hkdfSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addSecret, clearSecretRegistry, serializeEncFile, shareHash } from "@klaxon/core";
import { describe, expect, it } from "vitest";
import { runEmergency } from "../src/commands/emergency.js";
import { encDir, encFilePath, keychainAccount } from "../src/config/paths.js";
import type { CliDeps } from "../src/deps.js";
import {
  deriveShareB,
  emergencyCommitment,
  emergencyMemo,
  parseWitnessMaster,
  SHARE_B_SALT,
  shareBInfo,
} from "../src/share-b.js";
import {
  makeHarness,
  TEST_PRIV,
  TEST_PROJECT_ID,
  TEST_WSEK,
  tempDir,
  writeProjectConfig,
  writeSession,
} from "./helpers.js";

const MASTER_HEX = "11".repeat(32);
const MASTER = Buffer.from(MASTER_HEX, "hex");
const NAME = "DEPLOYER_PRIVATE_KEY";
const PLAINTEXT = "0xf00dbabe-not-a-real-key";
const PAY_TX = "0.0.1234@1757332800.000000000";

describe("share B derivation (PROTOCOL §3 / D28)", () => {
  it("matches a value pinned from the specified HKDF parameters", () => {
    const b = deriveShareB(MASTER, TEST_PROJECT_ID, NAME, "1");
    expect(b.toString("hex")).toBe(
      "735640dddf09e2ac2659bb04c8403fccc979cf069a752d4543d14e42a6673a07",
    );
    expect(shareHash(b)).toBe("24019281b9b5e4467fd8253ccd7210356a954ba313a45cb1f4bda575aacab63a");
  });

  it("is exactly HKDF-SHA256(master, 'klaxon/b/v1', project/secret/gen, 32)", () => {
    const expected = Buffer.from(
      hkdfSync(
        "sha256",
        MASTER,
        Buffer.from(SHARE_B_SALT, "utf8"),
        Buffer.from(`${TEST_PROJECT_ID}/${NAME}/1`, "utf8"),
        32,
      ),
    );
    expect(deriveShareB(MASTER, TEST_PROJECT_ID, NAME, "1")).toEqual(expected);
    expect(shareBInfo(TEST_PROJECT_ID, NAME, "1")).toBe(`${TEST_PROJECT_ID}/${NAME}/1`);
  });

  it("is deterministic and separated by secret and by generation", () => {
    const a = deriveShareB(MASTER, TEST_PROJECT_ID, NAME, "1");
    expect(deriveShareB(MASTER, TEST_PROJECT_ID, NAME, "1")).toEqual(a);
    expect(deriveShareB(MASTER, TEST_PROJECT_ID, NAME, "2")).not.toEqual(a);
    expect(deriveShareB(MASTER, TEST_PROJECT_ID, "OTHER", "1")).not.toEqual(a);
    expect(deriveShareB(Buffer.alloc(32, 2), TEST_PROJECT_ID, NAME, "1")).not.toEqual(a);
  });

  it("rejects a master that is not 32 bytes of hex", () => {
    expect(() => parseWitnessMaster("nope")).toThrowError(/32 bytes/);
    expect(parseWitnessMaster(`0x${MASTER_HEX}\n`)).toEqual(MASTER);
    expect(() => deriveShareB(Buffer.alloc(16), TEST_PROJECT_ID, NAME, "1")).toThrowError();
  });
});

describe("the emergency memo", () => {
  it("is a canonical hash of the recovery, not a release commitment", () => {
    const c = emergencyCommitment({
      project_id: TEST_PROJECT_ID,
      secret: NAME,
      gen: "1",
      ts: "2026-09-08T12:00:00.000Z",
    });
    expect(c.type).toBe("emergency");
    expect(emergencyMemo(c)).toMatch(/^[0-9a-f]{64}$/);
    expect(emergencyMemo(c)).toBe(emergencyMemo({ ...c }));
    expect(emergencyMemo({ ...c, gen: "2" })).not.toBe(emergencyMemo(c));
  });
});

interface PublishedMessage {
  topicId: string;
  accountId: string;
  message: string;
}

interface Bench {
  deps: CliDeps;
  cwd: string;
  transfers: Array<{ memo: string; to: string; amountTinybars: string }>;
  published: PublishedMessage[];
  stdout: () => string;
  stderr: () => string;
}

function bench(gen = "1"): Bench {
  const home = tempDir("klaxon-home-");
  const cwd = tempDir("klaxon-repo-");
  const xdg = join(home, "state");
  const dir = join(xdg, "ledger-wallet-cli");
  writeSession(dir);
  writeProjectConfig({ home });

  const shareB = deriveShareB(MASTER, TEST_PROJECT_ID, NAME, gen);
  const enc = addSecret({
    projectId: TEST_PROJECT_ID,
    secret: NAME,
    gen,
    plaintext: Buffer.from(PLAINTEXT, "utf8"),
    wsek: TEST_WSEK,
    shareB,
  });
  mkdirSync(encDir(cwd), { recursive: true });
  writeFileSync(encFilePath(cwd, NAME), serializeEncFile(enc));

  const transfers: Bench["transfers"] = [];
  const published: PublishedMessage[] = [];
  const h = makeHarness({
    home,
    cwd,
    env: {
      XDG_STATE_HOME: xdg,
      WITNESS_MASTER: MASTER_HEX,
      KLAXON_PAY_ACCOUNT: "0.0.1234",
      KLAXON_PAY_KEY: `0x${"ab".repeat(32)}`,
      HEDERA_OPERATOR_ID: "0.0.4242",
      HEDERA_OPERATOR_KEY: `0x${"cd".repeat(32)}`,
    },
    keychain: async (_s, account) => (account === keychainAccount(dir) ? TEST_PRIV : null),
    restoreWsek: async () => TEST_WSEK,
    memoTransfer: async (a) => {
      transfers.push({ memo: a.memo, to: a.to, amountTinybars: a.amountTinybars });
      return { payTx: PAY_TX, consensusTimestamp: "1757332800.000000000" };
    },
    publishTopicMessage: async (a) => {
      published.push({ topicId: a.topicId, accountId: a.accountId, message: a.message });
      return {
        sequenceNumber: "7",
        consensusTimestamp: "1757332801.000000000",
        transactionId: "0.0.4242@1757332801.000000000",
      };
    },
  });
  return { deps: h.deps, cwd, transfers, published, stdout: h.stdout, stderr: h.stderr };
}

describe("emergency", () => {
  it("recombines the secret from the paper master and the repo, and pays a memo transfer", async () => {
    const b = bench();
    const res = await runEmergency(b.deps, NAME, {});

    expect(b.stdout()).toBe(`${PLAINTEXT}\n`);
    expect(res.h).toMatch(/^[0-9a-f]{64}$/);
    expect(b.transfers).toEqual([{ memo: res.h, to: "0.0.9999", amountTinybars: "100000" }]);
    expect(b.stderr()).toContain(`pay_tx=${res.payTx}`);
  });

  it("publishes exactly one emergency message whose h is the payment memo (PROTOCOL §7)", async () => {
    const b = bench();
    const res = await runEmergency(b.deps, NAME, {});

    expect(b.published).toHaveLength(1);
    const sent = b.published[0];
    if (!sent) throw new Error("nothing published");
    expect(sent.topicId).toBe("0.0.48213");
    // The laptop key, not the paying account: it is the second member of the submit KeyList.
    expect(sent.accountId).toBe("0.0.4242");
    expect(JSON.parse(sent.message)).toEqual({
      klaxon: 1,
      type: "emergency",
      ts: "2026-09-08T12:00:00.000Z",
      project_id: TEST_PROJECT_ID,
      h: res.h,
      secret: NAME,
      gen: "1",
      pay_tx: PAY_TX,
    });
    expect(JSON.parse(sent.message).h).toBe(b.transfers[0]?.memo);
    expect(res.sequenceNumber).toBe("7");
    expect(b.stderr()).toContain("hcs emergency seq=7");
    expect(b.stderr()).toContain("hcs=7");
  });

  it("still hands over the secret when the publish fails, and says the record is incomplete", async () => {
    const b = bench();
    b.deps.publishTopicMessage = async () => {
      throw new Error("INVALID_SIGNATURE");
    };
    const res = await runEmergency(b.deps, NAME, {});

    expect(b.stdout()).toBe(`${PLAINTEXT}\n`);
    expect(res.payTx).toBe(PAY_TX);
    expect(res.sequenceNumber).toBeUndefined();
    expect(b.stderr()).toContain("was NOT published (INVALID_SIGNATURE)");
    expect(b.stderr()).toContain("publish this to topic 0.0.48213 by hand");
    // The message the operator has to send is printed verbatim so it can be copied.
    expect(
      JSON.parse(
        b
          .stderr()
          .split("\n")
          .find((l) => l.startsWith("{")) ?? "{}",
      ),
    ).toMatchObject({
      type: "emergency",
      h: res.h,
      pay_tx: PAY_TX,
    });
  });

  it("falls back to the paying account when HEDERA_OPERATOR_* is unset", async () => {
    const b = bench();
    b.deps.env.HEDERA_OPERATOR_ID = undefined;
    b.deps.env.HEDERA_OPERATOR_KEY = undefined;
    await runEmergency(b.deps, NAME, {});
    expect(b.published[0]?.accountId).toBe("0.0.1234");
  });

  it("prefers an explicit --operator-account over both", async () => {
    const b = bench();
    await runEmergency(b.deps, NAME, {
      operatorAccount: "0.0.5555",
      operatorKey: `0x${"ef".repeat(32)}`,
    });
    expect(b.published[0]?.accountId).toBe("0.0.5555");
  });

  it("works at a rotated generation", async () => {
    const b = bench("3");
    await runEmergency(b.deps, NAME, {});
    expect(b.stdout()).toBe(`${PLAINTEXT}\n`);
  });

  it("reads the master from a file when the env has none", async () => {
    const b = bench();
    const file = join(tempDir(), "witness-master.key");
    writeFileSync(file, `${MASTER_HEX}\n`);
    b.deps.env.WITNESS_MASTER = undefined;
    await runEmergency(b.deps, NAME, { masterFile: file });
    expect(b.stdout()).toBe(`${PLAINTEXT}\n`);
  });

  it("refuses a master that does not reproduce b_hash", async () => {
    const b = bench();
    b.deps.env.WITNESS_MASTER = "22".repeat(32);
    await expect(runEmergency(b.deps, NAME, {})).rejects.toThrowError(/does not match b_hash/);
    expect(b.transfers).toEqual([]);
    expect(b.published).toEqual([]);
  });

  it("says so when there is no master at all", async () => {
    const b = bench();
    b.deps.env.WITNESS_MASTER = undefined;
    await expect(runEmergency(b.deps, NAME, {})).rejects.toThrowError(/paper backup/);
  });

  it("refuses to print to a terminal without the flag", async () => {
    const b = bench();
    b.deps.isTty = () => true;
    await expect(runEmergency(b.deps, NAME, {})).rejects.toThrowError(/terminal/);
    b.deps.isTty = () => true;
    await expect(runEmergency(b.deps, NAME, { iKnowWhatImDoing: true })).resolves.toBeTruthy();
  });

  it("--no-pay skips the memo and says the recovery left no trace", async () => {
    const b = bench();
    const res = await runEmergency(b.deps, NAME, { noPay: true });
    expect(res.payTx).toBeUndefined();
    expect(res.sequenceNumber).toBeUndefined();
    expect(b.transfers).toEqual([]);
    expect(b.published).toEqual([]);
    expect(b.stderr()).toContain("no on-chain record");
  });

  it("requires a paying account when the memo is not skipped", async () => {
    const b = bench();
    b.deps.env.KLAXON_PAY_KEY = undefined;
    await expect(runEmergency(b.deps, NAME, {})).rejects.toThrowError(/--pay-account/);
  });

  it("masks the plaintext before printing it in CI", async () => {
    clearSecretRegistry();
    const b = bench();
    b.deps.env.GITHUB_ACTIONS = "true";
    await runEmergency(b.deps, NAME, {});
    const lines = b.stdout().trimEnd().split("\n");
    expect(lines.at(-1)).toBe(PLAINTEXT);
    expect(lines.filter((l) => l.startsWith("::add-mask::")).length).toBeGreaterThan(0);
    expect(lines.slice(0, -1).every((l) => l.startsWith("::add-mask::"))).toBe(true);
    expect(lines).toContain(`::add-mask::${PLAINTEXT}`);
  });
});
