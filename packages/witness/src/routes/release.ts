import { CommitmentSchema } from "@klaxon/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runRelease } from "../checks/pipeline.js";
import type { WitnessContext } from "../context.js";

const H_PARAM = /^[0-9a-f]{64}$/;

const ReleaseBodySchema = z
  .object({
    C: CommitmentSchema,
    jwt: z.string().min(1),
    sig: z.string().min(1),
  })
  .strict();

/**
 * PROTOCOL §2 — `GET /release/:h` answers 402 with `PaymentRequirements.extra.memo == h`;
 * `POST /release/:h` takes the `PAYMENT-SIGNATURE` header plus `{C, jwt, sig}` and runs the nine
 * checks.
 *
 * The witness learns `pay_tx` from settlement (`settle.transaction`) — the body never carries it,
 * so a client cannot name someone else's payment. The client reads it back from `PAYMENT-RESPONSE`.
 */
export function registerReleaseRoutes(app: FastifyInstance, ctx: WitnessContext): void {
  app.get<{ Params: { h: string } }>("/release/:h", async (req, reply) => {
    const h = req.params.h.toLowerCase();
    if (!H_PARAM.test(h)) {
      return reply.code(400).send({ ok: false, reason: "h must be 64 lowercase hex characters" });
    }
    const answer = await ctx.payment.buildRequirements(h).catch((err) => {
      ctx.log.error({ h, err }, "could not build payment requirements");
      return null;
    });
    if (!answer) {
      return reply
        .code(503)
        .send({ ok: false, h, class: "infra", check: 0, reason: "facilitator unavailable" });
    }
    return reply.code(402).header("PAYMENT-REQUIRED", answer.header).send(answer.body);
  });

  app.post<{ Params: { h: string } }>("/release/:h", async (req, reply) => {
    const h = req.params.h.toLowerCase();
    if (!H_PARAM.test(h)) {
      return reply.code(400).send({ ok: false, reason: "h must be 64 lowercase hex characters" });
    }

    const parsed = ReleaseBodySchema.safeParse(req.body);
    if (!parsed.success) {
      // Rejected before any payment is attempted, so a malformed request costs the caller nothing.
      return reply.code(400).send({ ok: false, h, reason: "malformed release request body" });
    }

    const signature = headerValue(req.headers["payment-signature"]);
    if (!signature) {
      const answer = await ctx.payment.buildRequirements(h).catch(() => null);
      if (!answer) {
        return reply
          .code(503)
          .send({ ok: false, h, class: "infra", check: 0, reason: "facilitator unavailable" });
      }
      return reply.code(402).header("PAYMENT-REQUIRED", answer.header).send(answer.body);
    }

    const settled = await ctx.payment.verifyAndSettle(h, signature);
    if (!settled.ok) {
      if (settled.infra) {
        return reply
          .code(503)
          .send({ ok: false, h, class: "infra", check: 1, reason: settled.reason });
      }
      return reply.code(402).send({ ok: false, h, reason: settled.reason });
    }

    const outcome = await runRelease(
      {
        config: ctx.config,
        repos: ctx.repos,
        payment: ctx.payment,
        source: ctx.source,
        oidc: ctx.oidc,
        clock: ctx.clock,
        log: ctx.log,
        db: ctx.db,
        hcs: ctx.hcs,
      },
      { h, body: parsed.data, C: parsed.data.C, payTx: settled.payTx },
    );

    reply.header("PAYMENT-RESPONSE", settled.responseHeader);
    await reply.code(outcome.status).send(outcome.body);
    // D29: fired after the reply is on the wire, never awaited, never load-bearing.
    if (outcome.alarm) ctx.alarm.refused(outcome.alarm);
    return reply;
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
