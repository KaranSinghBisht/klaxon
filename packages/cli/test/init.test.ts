import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveProjectId } from "@klaxon/core";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { parseConfig } from "../src/config/config-store.js";
import { keychainAccount } from "../src/config/paths.js";
import { hashPolicyBytes } from "../src/config/policy.js";
import type { CliDeps } from "../src/deps.js";
import type { CreateTopicArgs } from "../src/hedera/topic.js";
import type { WalletCliRunner } from "../src/wallet-cli/exec.js";
import {
  fakeFetch,
  makeHarness,
  TEST_PRIV,
  TEST_PUB,
  TEST_REGISTRY,
  TEST_ROOT_ID,
  tempDir,
  writeSession,
} from "./helpers.js";

const REPO = "acme/demo";
const REPO_ID = "123456789";
const SUBMIT_KEY = "302a300506032b657003210012345678";
const LABEL = "ethereum_sepolia-1";

const BASE_OPTS = {
  repository: REPO,
  repositoryId: REPO_ID,
  witness: "https://witness.example/",
  registry: TEST_REGISTRY,
  skipRingInit: false,
};

interface Bench {
  deps: CliDeps;
  home: string;
  cwd: string;
  walletArgs: string[][];
  topics: CreateTopicArgs[];
  fetchCalls: ReturnType<typeof fakeFetch>["calls"];
  stdout: () => string;
}

function bench(): Bench {
  const home = tempDir("klaxon-home-");
  const cwd = tempDir("klaxon-repo-");
  const xdg = join(home, "state");
  const dir = join(xdg, "ledger-wallet-cli");
  writeSession(dir);

  const walletArgs: string[][] = [];
  const runner: WalletCliRunner = async (args) => {
    walletArgs.push(args);
    if (args[0] === "account") {
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, data: { accounts: [{ label: LABEL }] } }),
        stderr: "",
      };
    }
    return {
      code: 0,
      stdout: JSON.stringify({ ok: true, data: { txHash: `0x${"11".repeat(32)}` } }),
      stderr: "",
    };
  };

  const { impl, calls } = fakeFetch({
    "/.well-known/klaxon.json": () => ({
      json: { klaxon: 1, submit_key: SUBMIT_KEY, hedera_account: "0.0.7777" },
    }),
    "/projects": () => ({ json: { ok: true } }),
  });

  const topics: CreateTopicArgs[] = [];
  const h = makeHarness({
    home,
    cwd,
    env: {
      XDG_STATE_HOME: xdg,
      HEDERA_OPERATOR_ID: "0.0.4242",
      HEDERA_OPERATOR_KEY: `0x${"cd".repeat(32)}`,
    },
    keychain: async (_s, account) => (account === keychainAccount(dir) ? TEST_PRIV : null),
    runWalletCli: runner,
    fetchImpl: impl,
    createTopic: async (a) => {
      topics.push(a);
      return { topicId: "0.0.48213" };
    },
  });
  return { deps: h.deps, home, cwd, walletArgs, topics, fetchCalls: calls, stdout: h.stdout };
}

describe("init", () => {
  it("walks the whole first-run sequence and leaves a usable project behind", async () => {
    const b = bench();
    const result = await runInit(b.deps, BASE_OPTS);

    const projectId = deriveProjectId(REPO_ID, TEST_ROOT_ID);
    expect(result.project.project_id).toBe(projectId);
    expect(result.topicId).toBe("0.0.48213");

    // 1. ring init, 2. account discover — the label comes out of the JSON, never hardcoded (D15).
    expect(b.walletArgs[0]).toEqual(["ring", "init", "--output", "json"]);
    expect(b.walletArgs[1]).toEqual([
      "account",
      "discover",
      "--network",
      "ethereum:sepolia",
      "--output",
      "json",
    ]);
    expect(result.project.account_label).toBe(LABEL);

    // 3. the topic: witness writes, laptop administers.
    expect(b.topics[0]).toMatchObject({
      memo: `klaxon:${projectId}`,
      submitKeyHex: SUBMIT_KEY,
      accountId: "0.0.4242",
      network: "testnet",
    });

    // 4. the witness learns the project over the member-signed channel.
    const projects = b.fetchCalls.find((c) => new URL(c.url).pathname === "/projects");
    if (!projects) throw new Error("no /projects call");
    expect(JSON.parse(projects.body.toString("utf8"))).toEqual({
      project_id: projectId,
      repository_id: REPO_ID,
      repository: REPO,
      member_pubkey: TEST_PUB,
      topic_id: "0.0.48213",
      ntfy_topic: `klaxon-${"5c".repeat(16)}`,
    });
    expect(projects.headers["x-klaxon-member-sig"]).toBeTruthy();

    // 5. the policy skeleton, hashed as its exact committed bytes.
    const policyBytes = readFileSync(join(b.cwd, "klaxon.policy.json"));
    expect(hashPolicyBytes(policyBytes)).toBe(result.policyHash);
    expect(JSON.parse(policyBytes.toString("utf8")).project_id).toBe(projectId);

    // 6. config.
    const cfg = parseConfig(readFileSync(join(b.home, ".klaxon", "config.json"), "utf8"));
    expect(cfg.default_project).toBe("demo");
    expect(cfg.projects.demo).toMatchObject({
      project_id: projectId,
      repository: REPO,
      witness_url: "https://witness.example",
      topic_id: "0.0.48213",
      registry_address: TEST_REGISTRY,
      hedera_account: "0.0.7777",
      member_pubkey: TEST_PUB,
      account_label: LABEL,
      last_epoch: 0,
    });
  });

  it("signs register then commitPolicy back to back in one device session (D19)", async () => {
    const b = bench();
    const result = await runInit(b.deps, BASE_OPTS);
    const sends = b.walletArgs.filter((a) => a[0] === "send");
    expect(sends).toHaveLength(2);
    expect(sends[0]?.[sends[0].indexOf("--data") + 1]).toMatch(/^0xe1fa8e84/);
    expect(sends[1]?.[sends[1].indexOf("--data") + 1]).toBe(
      `0x8ffae92b${result.project.project_id}${result.policyHash}`,
    );
    for (const send of sends) expect(send[send.indexOf("--account") + 1]).toBe(LABEL);
  });

  it("--dry-run rehearses both approvals", async () => {
    const b = bench();
    await runInit(b.deps, { ...BASE_OPTS, dryRun: true });
    for (const send of b.walletArgs.filter((a) => a[0] === "send")) {
      expect(send).toContain("--dry-run");
    }
  });

  it("--print-only stops before the device", async () => {
    const b = bench();
    await runInit(b.deps, { ...BASE_OPTS, printOnly: true });
    expect(b.walletArgs.filter((a) => a[0] === "send")).toHaveLength(0);
  });

  it("--skip-ring-init leaves an initialised Key Ring alone", async () => {
    const b = bench();
    await runInit(b.deps, { ...BASE_OPTS, skipRingInit: true });
    expect(b.walletArgs.some((a) => a[0] === "ring")).toBe(false);
  });

  it("refuses a repository id that is not GitHub's numeric id", async () => {
    const b = bench();
    await expect(runInit(b.deps, { ...BASE_OPTS, repositoryId: "acme/demo" })).rejects.toThrowError(
      /numeric repository id/,
    );
  });

  it("says which Hedera credential is missing", async () => {
    const b = bench();
    b.deps.env.HEDERA_OPERATOR_KEY = undefined;
    await expect(runInit(b.deps, BASE_OPTS)).rejects.toThrowError(/HEDERA_OPERATOR_ID/);
  });

  it("stops when the witness manifest carries no submit key", async () => {
    const b = bench();
    const { impl } = fakeFetch({
      "/.well-known/klaxon.json": () => ({ json: { klaxon: 1, hedera_account: "0.0.7777" } }),
    });
    b.deps.fetchImpl = impl;
    await expect(runInit(b.deps, BASE_OPTS)).rejects.toThrowError(/failed validation/);
    expect(b.topics).toHaveLength(0);
  });
});
