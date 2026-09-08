import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRegistryEvent } from "../src/adapters/registry-events.js";
import { silentLogger } from "../src/log.js";
import { createHarness, type Harness, PROJECT_ID } from "./helpers/harness.js";

/**
 * The state transitions the Sepolia watcher applies. Every one of them is a thing the operator's
 * Ledger physically signed, so getting them wrong either lets a stale policy stand or leaves a
 * project revoked forever.
 */
describe("KlaxonRegistry events", () => {
  let h: Harness;
  let deps: Parameters<typeof applyRegistryEvent>[0];

  beforeEach(async () => {
    h = await createHarness();
    h.registerProject({ policyHash: null });
    deps = { repos: h.repos, clock: h.now, log: silentLogger };
  });

  afterEach(async () => {
    await h.close();
  });

  it("mirrors a committed policy hash and its block", () => {
    applyRegistryEvent(deps, {
      eventName: "PolicyCommitted",
      args: { p: `0x${PROJECT_ID}`, hash: `0x${"e".repeat(64)}` },
      blockNumber: 7_654_321n,
    });

    expect(h.repos.projects.get(PROJECT_ID)).toMatchObject({
      policy_hash: "e".repeat(64),
      policy_block: 7_654_321,
    });
  });

  it("lifts a revocation once the chain epoch catches up, and says so on the topic", () => {
    h.repos.revocation.revoke(PROJECT_ID, "stolen laptop", null, h.now().toISOString());
    expect(h.repos.projects.get(PROJECT_ID)?.revoked).toBe(1);

    applyRegistryEvent(deps, {
      eventName: "Unrevoked",
      args: { p: `0x${PROJECT_ID}`, epoch: 1n },
      transactionHash: `0x${"1".repeat(64)}`,
    });

    expect(h.repos.projects.get(PROJECT_ID)).toMatchObject({ revoked: 0, chain_epoch: 1 });
    const queued = h.repos.outbox.pending()[0];
    expect(queued?.kind).toBe("unrevoke");
    expect(JSON.parse(queued?.payload ?? "{}")).toMatchObject({
      type: "unrevoke",
      epoch: "1",
      sepolia_tx: `0x${"1".repeat(64)}`,
    });
  });

  it("does not lift a revocation with a stale epoch", () => {
    h.repos.revocation.revoke(PROJECT_ID, "one", null, h.now().toISOString());
    h.repos.revocation.revoke(PROJECT_ID, "two", null, h.now().toISOString());

    applyRegistryEvent(deps, {
      eventName: "Unrevoked",
      args: { p: `0x${PROJECT_ID}`, epoch: 1n },
    });

    // local_epoch is 2; an unrevoke for epoch 1 does not clear it.
    expect(h.repos.projects.get(PROJECT_ID)).toMatchObject({ revoked: 1, chain_epoch: 1 });
  });

  it("records the device address that claimed the project", () => {
    applyRegistryEvent(deps, {
      eventName: "Registered",
      args: { p: `0x${PROJECT_ID}`, owner: "0xAbC0000000000000000000000000000000000001" },
    });
    expect(h.repos.projects.get(PROJECT_ID)?.owner_address).toBe(
      "0xAbC0000000000000000000000000000000000001",
    );
  });

  it("ignores an event for a project it does not host", () => {
    applyRegistryEvent(deps, {
      eventName: "PolicyCommitted",
      args: { p: `0x${"9".repeat(64)}`, hash: `0x${"e".repeat(64)}` },
      blockNumber: 1n,
    });
    expect(h.repos.projects.get(PROJECT_ID)?.policy_hash).toBeNull();
    expect(h.repos.outbox.pending()).toHaveLength(0);
  });

  it("ignores an event with no project id", () => {
    expect(() =>
      applyRegistryEvent(deps, { eventName: "PolicyCommitted", args: {} }),
    ).not.toThrow();
  });
});
