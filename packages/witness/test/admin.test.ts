import { b64u, signMemberRequest } from "@klaxon/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveShareB, shareBHash } from "../src/shares/derive.js";
import { REPOSITORY, REPOSITORY_ID, SECRET, TOPIC_ID } from "./helpers/fixtures.js";
import {
  createHarness,
  type Harness,
  MEMBER_PUB,
  NTFY_TOPIC,
  PROJECT_ID,
} from "./helpers/harness.js";

/**
 * PROTOCOL §2 admin routes. Every one of them is authenticated with the LKRP member key (D27):
 * no operator API key exists, so there is no second secret to leak.
 */
describe("member-signed admin routes", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  const post = async (path: string, body: unknown, headers?: Record<string, string>) =>
    h.app.inject({
      method: "POST",
      url: path,
      headers: {
        "content-type": "application/json",
        ...(headers ?? h.memberHeaders("POST", path, body)),
      },
      payload: JSON.stringify(body),
    });

  const projectBody = {
    project_id: PROJECT_ID,
    repository_id: REPOSITORY_ID,
    repository: REPOSITORY,
    member_pubkey: MEMBER_PUB,
    topic_id: TOPIC_ID,
    ntfy_topic: NTFY_TOPIC,
  };

  it("registers a project signed by the key it registers", async () => {
    const res = await post("/projects", projectBody);
    expect(res.statusCode).toBe(200);
    expect(h.repos.projects.get(PROJECT_ID)).toMatchObject({
      repository: REPOSITORY,
      member_pubkey: MEMBER_PUB,
      topic_id: TOPIC_ID,
    });
  });

  it("will not let a second key re-register an existing project", async () => {
    await post("/projects", projectBody);
    const otherPriv = "22".repeat(32);
    const body = { ...projectBody, member_pubkey: MEMBER_PUB };
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const headers = signMemberRequest(otherPriv, MEMBER_PUB, "POST", "/projects", raw, h.now());

    const res = await post("/projects", body, { ...headers });
    expect(res.statusCode).toBe(401);
  });

  describe("/shares", () => {
    beforeEach(async () => {
      await post("/projects", projectBody);
    });

    it("returns the derived B and records only its hash", async () => {
      const body = { project_id: PROJECT_ID, secret: SECRET, gen: "1" };
      const res = await post("/shares", body);

      expect(res.statusCode).toBe(200);
      const payload = res.json() as { ok: boolean; b: string; b_hash: string };
      const expected = deriveShareB(h.config.WITNESS_MASTER, PROJECT_ID, SECRET, "1");
      expect(b64u.decode(payload.b).equals(expected)).toBe(true);
      expect(payload.b_hash).toBe(shareBHash(expected));

      // D28: what is on disk is the hash, never the share.
      const row = h.repos.shares.get(PROJECT_ID, SECRET, 1);
      expect(row?.b_hash).toBe(payload.b_hash);
      expect(Object.keys(row ?? {})).not.toContain("b_enc");
    });

    it("answers 401 for a bad member signature", async () => {
      const body = { project_id: PROJECT_ID, secret: SECRET, gen: "1" };
      const headers = h.memberHeaders("POST", "/shares", body);
      const tampered = { ...headers, "x-klaxon-member-sig": b64u.encode(Buffer.alloc(70, 7)) };

      const res = await post("/shares", body, tampered);
      expect(res.statusCode).toBe(401);
      expect(h.repos.shares.get(PROJECT_ID, SECRET, 1)).toBeNull();
    });

    it("answers 401 when the signature was made over a different body", async () => {
      const headers = h.memberHeaders("POST", "/shares", {
        project_id: PROJECT_ID,
        secret: "X",
        gen: "1",
      });
      const res = await post(
        "/shares",
        { project_id: PROJECT_ID, secret: SECRET, gen: "1" },
        headers,
      );
      expect(res.statusCode).toBe(401);
    });

    it("is first-write-wins", async () => {
      const body = { project_id: PROJECT_ID, secret: SECRET, gen: "1" };
      const first = await post("/shares", body);
      h.repos.shares.retire(PROJECT_ID, SECRET, 1);

      const second = await post("/shares", body);

      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      // The existing row is not replaced, so retiring it is not undone by a repeat call.
      expect(h.repos.shares.get(PROJECT_ID, SECRET, 1)?.retired).toBe(1);
    });

    it("rejects a generation that is not current", async () => {
      const res = await post("/shares", { project_id: PROJECT_ID, secret: SECRET, gen: "5" });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("/rotate", () => {
    beforeEach(async () => {
      await post("/projects", projectBody);
      await post("/shares", { project_id: PROJECT_ID, secret: SECRET, gen: "1" });
    });

    it("advances the generation, retires the old share and publishes rotate", async () => {
      const res = await post("/rotate", { project_id: PROJECT_ID, secret: SECRET, gen: "2" });

      expect(res.statusCode).toBe(200);
      expect(h.repos.projects.get(PROJECT_ID)?.current_gen).toBe(2);
      expect(h.repos.shares.get(PROJECT_ID, SECRET, 1)?.retired).toBe(1);
      expect(h.repos.shares.get(PROJECT_ID, SECRET, 2)?.retired).toBe(0);

      const rotate = h.hcs.ofType("rotate")[0];
      expect(rotate?.message).toMatchObject({ from_gen: "1", to_gen: "2", secret: SECRET });

      const payload = res.json() as { b: string };
      const gen2 = deriveShareB(h.config.WITNESS_MASTER, PROJECT_ID, SECRET, "2");
      expect(b64u.decode(payload.b).equals(gen2)).toBe(true);
    });

    it("refuses a generation that is not current + 1", async () => {
      const res = await post("/rotate", { project_id: PROJECT_ID, secret: SECRET, gen: "3" });
      expect(res.statusCode).toBe(409);
      expect(h.repos.projects.get(PROJECT_ID)?.current_gen).toBe(1);
    });
  });

  describe("/revoke", () => {
    beforeEach(async () => {
      await post("/projects", projectBody);
    });

    it("revokes, advances the epoch and publishes revoke", async () => {
      const res = await post("/revoke", { project_id: PROJECT_ID, reason: "laptop stolen" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, epoch: 1 });
      expect(h.repos.projects.get(PROJECT_ID)?.revoked).toBe(1);
      expect(h.repos.projects.get(PROJECT_ID)?.local_epoch).toBe(1);
      expect(h.hcs.ofType("revoke")[0]?.message).toMatchObject({
        reason: "laptop stolen",
        epoch: "1",
      });
    });

    it("comes back only when the chain epoch catches up", async () => {
      await post("/revoke", { project_id: PROJECT_ID, reason: "test" });
      h.repos.projects.setChainEpoch(PROJECT_ID, 1);
      expect(h.repos.projects.get(PROJECT_ID)?.revoked).toBe(0);
    });

    it("answers 404 for an unknown project", async () => {
      const body = { project_id: "b".repeat(64), reason: "nope" };
      const res = await post("/revoke", body);
      expect(res.statusCode).toBe(404);
    });
  });
});
