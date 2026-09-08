import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPath,
  encFilePath,
  KEYCHAIN_SERVICE,
  keychainAccount,
  klaxonHome,
  policyPath,
  sessionPath,
  stateDir,
  witnessMasterPath,
} from "../src/config/paths.js";

describe("stateDir", () => {
  it("defaults to ~/.local/state/ledger-wallet-cli", () => {
    expect(stateDir({}, "/Users/op")).toBe("/Users/op/.local/state/ledger-wallet-cli");
  });

  it("honours XDG_STATE_HOME", () => {
    expect(stateDir({ XDG_STATE_HOME: "/var/state" }, "/Users/op")).toBe(
      "/var/state/ledger-wallet-cli",
    );
  });

  it("ignores an empty or whitespace XDG_STATE_HOME the way wallet-cli does", () => {
    expect(stateDir({ XDG_STATE_HOME: "   " }, "/Users/op")).toBe(
      "/Users/op/.local/state/ledger-wallet-cli",
    );
  });

  it("resolves a relative XDG_STATE_HOME to an absolute path", () => {
    const dir = stateDir({ XDG_STATE_HOME: "relative/state" }, "/Users/op");
    expect(dir.startsWith("/")).toBe(true);
    expect(dir.endsWith("/relative/state/ledger-wallet-cli")).toBe(true);
  });

  it("never leaves a trailing separator, which would change the account hash", () => {
    expect(stateDir({ XDG_STATE_HOME: "/var/state/" }, "/Users/op")).toBe(
      "/var/state/ledger-wallet-cli",
    );
  });
});

describe("keychainAccount", () => {
  it("is member-private-key- plus the first 16 hex of sha256(stateDir)", () => {
    const dir = "/tmp/xdg/ledger-wallet-cli";
    const expected = createHash("sha256").update(dir, "utf8").digest("hex").slice(0, 16);
    expect(expected).toBe("c7a0ee49bc0e11bb");
    expect(keychainAccount(dir)).toBe(`member-private-key-${expected}`);
    expect(keychainAccount(dir)).toHaveLength("member-private-key-".length + 16);
  });

  it("hashes the full joined path including the app name", () => {
    expect(keychainAccount("/tmp/xdg/ledger-wallet-cli")).not.toBe(keychainAccount("/tmp/xdg"));
  });

  it("uses the service name wallet-cli 2.1.0 writes", () => {
    expect(KEYCHAIN_SERVICE).toBe("ledger-wallet-cli");
  });
});

describe("file locations", () => {
  it("puts config under ~/.klaxon unless KLAXON_HOME overrides it", () => {
    expect(configPath({}, "/Users/op")).toBe("/Users/op/.klaxon/config.json");
    expect(klaxonHome({ KLAXON_HOME: "/tmp/k" }, "/Users/op")).toBe("/tmp/k");
    expect(witnessMasterPath({ KLAXON_HOME: "/tmp/k" }, "/Users/op")).toBe(
      "/tmp/k/witness-master.key",
    );
  });

  it("derives the repo-local paths", () => {
    expect(sessionPath("/s")).toBe(join("/s", "session.yaml"));
    expect(encFilePath("/repo", "DEPLOYER_PRIVATE_KEY")).toBe(
      "/repo/.klaxon/DEPLOYER_PRIVATE_KEY.enc",
    );
    expect(policyPath("/repo")).toBe("/repo/klaxon.policy.json");
  });
});
