import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPolicyCommit } from "../src/commands/policy-commit.js";
import { runRevoke } from "../src/commands/revoke.js";
import { runUnrevoke } from "../src/commands/unrevoke.js";
import { parseConfig } from "../src/config/config-store.js";
import { keychainAccount } from "../src/config/paths.js";
import { policySkeleton, serializePolicy } from "../src/config/policy.js";
import type { CliDeps } from "../src/deps.js";
import type { WalletCliRunner } from "../src/wallet-cli/exec.js";
import {
  fakeFetch,
  makeHarness,
  TEST_PRIV,
  TEST_PROJECT_ID,
  tempDir,
  writeProjectConfig,
  writeSession,
} from "./helpers.js";

const LABEL = "ethereum_sepolia-1";

interface Bench {
  deps: CliDeps;
  home: string;
  cwd: string;
  walletArgs: string[][];
  stdout: () => string;
}

function bench(routes: Parameters<typeof fakeFetch>[0] = {}): Bench {
  const home = tempDir("klaxon-home-");
  const cwd = tempDir("klaxon-repo-");
  const xdg = join(home, "state");
  const dir = join(xdg, "ledger-wallet-cli");
  writeSession(dir);
  writeProjectConfig({ home });

  const walletArgs: string[][] = [];
  const runner: WalletCliRunner = async (args) => {
    walletArgs.push(args);
    const data =
      args[0] === "account" ? { accounts: [{ label: LABEL }] } : { txHash: `0x${"22".repeat(32)}` };
    return { code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: "" };
  };
  const { impl } = fakeFetch(routes);
  const h = makeHarness({
    home,
    cwd,
    env: { XDG_STATE_HOME: xdg },
    keychain: async (_s, account) => (account === keychainAccount(dir) ? TEST_PRIV : null),
    runWalletCli: runner,
    fetchImpl: impl,
  });
  return { deps: h.deps, home, cwd, walletArgs, stdout: h.stdout };
}

function writePolicy(cwd: string, projectId = TEST_PROJECT_ID): string {
  const file = join(cwd, "klaxon.policy.json");
  writeFileSync(file, serializePolicy(policySkeleton({ projectId, repositoryId: "123456789" })));
  return file;
}

describe("policy commit", () => {
  it("prints the hash and calldata before the device is asked for anything", async () => {
    const b = bench();
    writePolicy(b.cwd);
    const hash = await runPolicyCommit(b.deps, { printOnly: true });
    expect(b.stdout()).toContain(`policy_hash ${hash}`);
    expect(b.stdout()).toContain(`calldata    0x8ffae92b${TEST_PROJECT_ID}${hash}`);
    expect(b.walletArgs).toHaveLength(0);
  });

  it("discovers the account label once and caches it in config", async () => {
    const b = bench();
    writePolicy(b.cwd);
    const hash = await runPolicyCommit(b.deps, {});
    expect(b.walletArgs[0]?.[0]).toBe("account");
    const send = b.walletArgs.find((a) => a[0] === "send");
    if (!send) throw new Error("no send");
    expect(send[send.indexOf("--account") + 1]).toBe(LABEL);
    expect(send[send.indexOf("--data") + 1]).toBe(`0x8ffae92b${TEST_PROJECT_ID}${hash}`);
    const cfg = parseConfig(readFileSync(join(b.home, ".klaxon", "config.json"), "utf8"));
    expect(cfg.projects.demo?.account_label).toBe(LABEL);
  });

  it("refuses a policy that names a different project", async () => {
    const b = bench();
    writePolicy(b.cwd, "f".repeat(64));
    await expect(runPolicyCommit(b.deps, {})).rejects.toThrowError(/names project_id/);
  });

  it("says the policy file is missing rather than committing nothing", async () => {
    const b = bench();
    await expect(runPolicyCommit(b.deps, {})).rejects.toThrowError(/no policy file/);
  });
});

describe("revoke", () => {
  it("is member-signed, needs no device, and records the epoch", async () => {
    const b = bench({ "/revoke": () => ({ json: { ok: true, epoch: 5 } }) });
    expect(await runRevoke(b.deps, { reason: "laptop seized" })).toBe(5);
    expect(b.walletArgs).toHaveLength(0);
    const cfg = parseConfig(readFileSync(join(b.home, ".klaxon", "config.json"), "utf8"));
    expect(cfg.projects.demo?.last_epoch).toBe(5);
    expect(b.stdout()).toContain("revoked demo epoch=5");
  });

  it("insists on a reason", async () => {
    const b = bench();
    await expect(runRevoke(b.deps, { reason: "  " })).rejects.toThrowError(/--reason/);
  });
});

describe("unrevoke", () => {
  it("submits last_epoch + 1 and records it", async () => {
    const b = bench({ "/revoke": () => ({ json: { ok: true, epoch: 5 } }) });
    await runRevoke(b.deps, { reason: "drill" });
    expect(await runUnrevoke(b.deps, {})).toBe(6n);

    const send = b.walletArgs.find((a) => a[0] === "send");
    if (!send) throw new Error("no send");
    expect(send[send.indexOf("--data") + 1]).toBe(`0x0f33125d${TEST_PROJECT_ID}${"0".repeat(63)}6`);
    const cfg = parseConfig(readFileSync(join(b.home, ".klaxon", "config.json"), "utf8"));
    expect(cfg.projects.demo?.last_epoch).toBe(6);
  });

  it("starts at 1 on a project that has never been revoked", async () => {
    const b = bench();
    expect(await runUnrevoke(b.deps, { printOnly: true })).toBe(1n);
  });

  it("honours an explicit --epoch when the chain is ahead of the file", async () => {
    const b = bench();
    expect(await runUnrevoke(b.deps, { epoch: "9", printOnly: true })).toBe(9n);
    await expect(runUnrevoke(b.deps, { epoch: "-1" })).rejects.toThrowError(/digits/);
  });

  it("does not advance the recorded epoch on a dry run", async () => {
    const b = bench();
    await runUnrevoke(b.deps, { dryRun: true });
    const cfg = parseConfig(readFileSync(join(b.home, ".klaxon", "config.json"), "utf8"));
    expect(cfg.projects.demo?.last_epoch).toBe(0);
  });
});
