import { describe, expect, it } from "vitest";
import { verify } from "../src/index.js";
import { type RegistryTimeline, readRegistryTimeline } from "../src/registry.js";
import { exitCodeFor, renderHuman } from "../src/report.js";
import { checkScope } from "../src/scope.js";
import {
  fakeNetwork,
  fakeRegistry,
  OWNER_ADDRESS,
  PROJECT_ID,
  REGISTRY,
  TOPIC_ID,
  topicMessage,
  WITNESS,
  ZERO,
} from "./helpers/scenario.js";

const NOW = new Date(1_788_849_000_000);
const OTHER_ACCOUNT = "0.0.9999";

const jwksMessage = {
  klaxon: 1,
  type: "jwks",
  ts: "2026-09-09T00:00:00.000Z",
  project_id: PROJECT_ID,
  keys: [{ kid: "gh-2026-09", kty: "RSA" }],
};

async function timelineOf(options: Parameters<typeof fakeRegistry>[0] = {}) {
  return readRegistryTimeline(fakeRegistry(options));
}

function scopeInput(timeline: RegistryTimeline | null, transport = fakeRegistry()) {
  return {
    witnessAccount: WITNESS,
    projectIds: [PROJECT_ID],
    topicSubmitters: [WITNESS],
    timeline,
    transport,
  };
}

describe("the audited scope", () => {
  it("confirms the project is registered from contract state and names the owner", async () => {
    const transport = fakeRegistry({ owner: OWNER_ADDRESS });
    const { scope, findings } = await checkScope(
      scopeInput(await timelineOf({ owner: OWNER_ADDRESS }), transport),
    );
    expect(scope.registered).toBe(true);
    expect(scope.owner).toBe(OWNER_ADDRESS);
    expect(scope.basis).toBe("KlaxonRegistry.owner(p)");
    expect(findings).toEqual([]);
  });

  it("reports a project the registry has no owner for", async () => {
    const transport = fakeRegistry({ owner: ZERO });
    const { scope, findings } = await checkScope(
      scopeInput(await timelineOf({ owner: ZERO }), transport),
    );
    expect(scope.registered).toBe(false);
    expect(findings.map((f) => f.code)).toEqual(["PROJECT_NOT_REGISTERED"]);
    expect(findings[0]?.severity).toBe("violation");
  });

  it("falls back to the Registered event when the transport cannot read state", async () => {
    const { scope, findings } = await checkScope(
      scopeInput(await timelineOf({ registered: true }), fakeRegistry({ registered: true })),
    );
    expect(scope.registered).toBe(true);
    expect(scope.owner).toBe(OWNER_ADDRESS);
    expect(scope.basis).toMatch(/^Registered in block /);
    expect(findings).toEqual([]);
  });

  it("says it does not know rather than passing, when neither answers", async () => {
    const { scope, findings } = await checkScope(scopeInput(await timelineOf()));
    expect(scope.registered).toBeNull();
    expect(scope.basis).toMatch(/no Registered event in blocks .* may predate them/);
    // Not knowing is not a finding against the witness, and must never read as a pass.
    expect(findings).toEqual([]);
  });

  it("says so when no --registry was given at all", async () => {
    const { scope } = await checkScope({ ...scopeInput(null), transport: null });
    expect(scope.registered).toBeNull();
    expect(scope.basis).toBe("no --registry was given");
  });

  it("keeps the extra project ids on a topic that is not the one project it claims", async () => {
    const other = "b".repeat(64);
    const { scope } = await checkScope({
      ...scopeInput(await timelineOf()),
      projectIds: [PROJECT_ID, other],
    });
    expect(scope.projectId).toBe(PROJECT_ID);
    expect(scope.extraProjectIds).toEqual([other]);
  });

  it("notices that the supplied witness account never submitted to the supplied topic", async () => {
    const { scope } = await checkScope({
      ...scopeInput(await timelineOf()),
      topicSubmitters: [OTHER_ACCOUNT],
    });
    expect(scope.witnessSubmitted).toBe(false);
    expect(scope.topicSubmitters).toEqual([OTHER_ACCOUNT]);
  });
});

describe("the scope in the report", () => {
  async function run(registry = fakeRegistry({ owner: OWNER_ADDRESS })) {
    const net = fakeNetwork({
      messages: [topicMessage(jwksMessage, "1788848300.000000000")],
      transactions: [],
      policyBytes: null,
    });
    return verify(
      {
        topicId: TOPIC_ID,
        witnessAccount: WITNESS,
        registryAddress: REGISTRY,
        mirrorUrl: "https://mirror.example",
        now: NOW,
      },
      { fetch: net.fetch, registry },
    );
  }

  it("prints what was checked against what", async () => {
    const report = await run();
    const text = renderHuman(report);
    expect(text).toContain("project registered");
    expect(text).toContain(`${PROJECT_ID.slice(0, 12)}…`);
    // Abbreviated for the camera; the full address a reader compares with the Ledger is in --json.
    expect(text).toContain(`owner ${OWNER_ADDRESS.slice(0, 10)}…${OWNER_ADDRESS.slice(-8)}`);
    expect(text).toContain("KlaxonRegistry.owner(p)");
    expect(report.scope.owner).toBe(OWNER_ADDRESS);
  });

  it("says plainly that the topic and witness account are attested by nothing on chain", async () => {
    const report = await run();
    const text = renderHuman(report);
    expect(text).toContain("topic + witness");
    expect(text).toContain("not attested on chain");
    expect(text).toContain(`${WITNESS} submitted messages on this topic`);
    expect(report.scope.witnessSubmitted).toBe(true);
  });

  it("exits 1 when the registry the operator supplied does not know the project", async () => {
    const report = await run(fakeRegistry({ owner: ZERO }));
    expect(report.scope.registered).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain("PROJECT_NOT_REGISTERED");
    expect(exitCodeFor(report)).toBe(1);
  });
});
