import { b64u } from "@klaxon/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { WitnessContext } from "../context.js";
import type { ProjectRow } from "../db/index.js";
import { immediateTransaction } from "../db/index.js";
import { revokeEnvelope, rotateEnvelope } from "../hcs/envelope.js";
import { publishOutboxId } from "../hcs/publish.js";
import { deriveShareB, shareBHash } from "../shares/derive.js";
import { checkMemberSignature, claimedMemberPubkey } from "./member-auth.js";

const HEX64 = /^[0-9a-f]{64}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const DIGITS = /^[0-9]+$/;

const ProjectSchema = z
  .object({
    project_id: z.string().regex(HEX64),
    repository_id: z.string().regex(DIGITS),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    member_pubkey: z.string().regex(/^0[23][0-9a-f]{64}$/),
    topic_id: z.string().regex(/^\d+\.\d+\.\d+$/),
    ntfy_topic: z
      .string()
      .regex(/^[-_A-Za-z0-9]{1,64}$/)
      .optional(),
  })
  .strict();

const ShareSchema = z
  .object({
    project_id: z.string().regex(HEX64),
    secret: z.string().regex(SECRET_NAME),
    gen: z.string().regex(DIGITS),
  })
  .strict();

const RevokeSchema = z
  .object({ project_id: z.string().regex(HEX64), reason: z.string().min(1).max(500) })
  .strict();

/**
 * PROTOCOL §2 admin surface, all four routes authenticated with the LKRP member key (D27).
 * `/shares` and `/rotate` hand back a **derived** B (PROTOCOL §3, D28) — the witness stores only
 * its hash, so there is no share ciphertext on the box to lose or to steal.
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: WitnessContext): void {
  app.post("/projects", async (req, reply) => {
    const parsed = ProjectSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, "malformed project registration");
    const body = parsed.data;

    const existing = ctx.repos.projects.get(body.project_id);
    // Bootstrap: before a project row exists there is nothing to check against, so the
    // registration is self-signed by the key it registers. Afterwards the stored key rules, so a
    // second caller cannot re-register the project under their own key.
    const expected = existing ? existing.member_pubkey : body.member_pubkey;
    if (claimedMemberPubkey(req) !== expected) return unauthorized(reply);
    const auth = checkMemberSignature(req, expected, ctx.clock());
    if (!auth.ok) return unauthorized(reply, auth.reason);

    ctx.repos.projects.insert({
      project_id: body.project_id,
      repository: body.repository,
      repository_id: body.repository_id,
      member_pubkey: body.member_pubkey,
      topic_id: body.topic_id,
      ntfy_topic: body.ntfy_topic ?? null,
      max_releases: ctx.config.KLAXON_MAX_RELEASES_DEFAULT,
      created_at: ctx.clock().toISOString(),
    });
    return reply.code(200).send({ ok: true });
  });

  app.post("/shares", async (req, reply) => {
    const parsed = ShareSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, "malformed share request");
    const guard = authorize(ctx, req, reply, parsed.data.project_id);
    if (!guard.ok) return guard.reply;
    const project = guard.project;

    if (parsed.data.gen !== String(project.current_gen)) {
      return reply
        .code(409)
        .send({ ok: false, reason: `generation must be ${project.current_gen}` });
    }
    return reply.code(200).send(recordShare(ctx, project, parsed.data.secret, parsed.data.gen));
  });

  app.post("/rotate", async (req, reply) => {
    const parsed = ShareSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, "malformed rotate request");
    const guard = authorize(ctx, req, reply, parsed.data.project_id);
    if (!guard.ok) return guard.reply;
    const project = guard.project;

    const from = project.current_gen;
    const to = Number(parsed.data.gen);
    if (to !== from + 1) {
      return reply.code(409).send({ ok: false, reason: `next generation must be ${from + 1}` });
    }

    const at = ctx.clock().toISOString();
    const outboxId = immediateTransaction(ctx.db, () => {
      ctx.repos.shares.retire(project.project_id, parsed.data.secret, from);
      ctx.repos.projects.setCurrentGen(project.project_id, to);
      return ctx.repos.outbox.enqueue(
        project.topic_id,
        "rotate",
        rotateEnvelope({
          ts: at,
          projectId: project.project_id,
          secret: parsed.data.secret,
          fromGen: String(from),
          toGen: String(to),
        }),
        at,
      );
    });
    await publish(ctx, outboxId);

    const rotated = ctx.repos.projects.get(project.project_id) ?? project;
    return reply.code(200).send(recordShare(ctx, rotated, parsed.data.secret, parsed.data.gen));
  });

  app.post("/revoke", async (req, reply) => {
    const parsed = RevokeSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, "malformed revoke request");
    const guard = authorize(ctx, req, reply, parsed.data.project_id);
    if (!guard.ok) return guard.reply;
    const project = guard.project;

    const at = ctx.clock().toISOString();
    const { epoch, outboxId } = immediateTransaction(ctx.db, () => {
      const next = ctx.repos.revocation.revoke(project.project_id, parsed.data.reason, null, at);
      const id = ctx.repos.outbox.enqueue(
        project.topic_id,
        "revoke",
        revokeEnvelope({
          ts: at,
          projectId: project.project_id,
          reason: parsed.data.reason,
          epoch: next,
        }),
        at,
      );
      return { epoch: next, outboxId: id };
    });
    await publish(ctx, outboxId);
    return reply.code(200).send({ ok: true, epoch });
  });
}

type Guard = { ok: true; project: ProjectRow } | { ok: false; reply: FastifyReply };

function authorize(
  ctx: WitnessContext,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
): Guard {
  const project = ctx.repos.projects.get(projectId);
  if (!project) return { ok: false, reply: notFound(reply) };
  const auth = checkMemberSignature(req, project.member_pubkey, ctx.clock());
  if (!auth.ok) return { ok: false, reply: unauthorized(reply, auth.reason) };
  return { ok: true, project };
}

/**
 * B is a pure function of the master and `(project, secret, gen)`, so recording a share twice is
 * idempotent by construction; `INSERT OR IGNORE` keeps the first row's `created_at` and `retired`.
 */
function recordShare(
  ctx: WitnessContext,
  project: ProjectRow,
  secret: string,
  gen: string,
): { ok: true; b: string; b_hash: string } {
  const b = deriveShareB(ctx.config.WITNESS_MASTER, project.project_id, secret, gen);
  const hash = shareBHash(b);
  ctx.repos.shares.insert({
    project_id: project.project_id,
    secret,
    gen: Number(gen),
    b_hash: hash,
    created_at: ctx.clock().toISOString(),
  });
  return { ok: true, b: b64u.encode(b), b_hash: hash };
}

async function publish(ctx: WitnessContext, outboxId: number): Promise<void> {
  await publishOutboxId({ hcs: ctx.hcs, outbox: ctx.repos.outbox, log: ctx.log }, outboxId);
}

function badRequest(reply: FastifyReply, reason: string): FastifyReply {
  return reply.code(400).send({ ok: false, reason });
}

function unauthorized(reply: FastifyReply, reason = "member signature required"): FastifyReply {
  return reply.code(401).send({ ok: false, reason });
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ ok: false, reason: "unknown project" });
}
