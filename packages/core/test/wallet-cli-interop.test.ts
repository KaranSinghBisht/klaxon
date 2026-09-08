import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ringDecrypt, ringEncrypt } from "../src/lkrp/domain-key.js";

/**
 * Gate A — the proof of the entire Ledger claim (A §7.1). Opt-in: needs a real provisioned ring on
 * this machine (`wallet-cli ring init` done) and network to Ledger's trustchain API.
 *
 *   KLAXON_WALLET_CLI_INTEROP=1 KLAXON_TEST_WSEK=<hex from restoreWalletSyncKey> pnpm test
 */
const enabled = process.env.KLAXON_WALLET_CLI_INTEROP === "1";
const wsek = process.env.KLAXON_TEST_WSEK ?? "";

describe.skipIf(!enabled)("wallet-cli ring interop", () => {
  const keyName = `klaxon/interop/${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), "klaxon-interop-"));

  it("real `wallet-cli ring decrypt` opens a blob we produced", () => {
    const pt = randomBytes(32);
    const blob = ringEncrypt(wsek, keyName, pt);
    const inPath = join(dir, "ours.bin");
    const outPath = join(dir, "ours.out");
    writeFileSync(inPath, blob);
    execFileSync("wallet-cli", ["ring", "decrypt", "--key", keyName, "-i", inPath, "-o", outPath], {
      env: { ...process.env, WALLET_PASS: process.env.WALLET_PASS ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(readFileSync(outPath)).toEqual(pt);
  });

  it("our ringDecrypt opens a blob real `wallet-cli ring encrypt` produced", () => {
    const pt = randomBytes(32);
    const inPath = join(dir, "theirs.in");
    const outPath = join(dir, "theirs.bin");
    writeFileSync(inPath, pt);
    execFileSync("wallet-cli", ["ring", "encrypt", "--key", keyName, "-i", inPath, "-o", outPath], {
      env: { ...process.env, WALLET_PASS: process.env.WALLET_PASS ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(ringDecrypt(wsek, keyName, readFileSync(outPath))).toEqual(pt);
  });
});
