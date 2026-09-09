import { CommitmentSchema } from "@klaxon/core";
import { encodePaymentResponseHeader } from "@x402/core/http";
import type { Network } from "@x402/core/types";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { PipelineDeps, ReleaseOutcome } from "../checks/pipeline.js";
import { replayRelease, runRelease } from "../checks/pipeline.js";
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
    const deps = pipelineDeps(ctx);

    // A §5.4 — before any money moves. Settling is not idempotent: the facilitator hands back a
    // *new* transaction id for a retried POST, and the release row's `pay_tx` then disagrees with a
    // payment the runner never meant to make. The disagreement landed on check 9 as `policy`, so
    // retrying a dropped response revoked the project. The payment for this `h` already settled and
    // is already on the topic; a second one buys nothing the record does not already say.
    const replayed = await replayRelease(deps, { h, body: parsed.data, C: parsed.data.C });
    if (replayed) return await answerFromRecord(ctx, reply, h, replayed);

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

    const outcome = await runRelease(deps, {
      h,
      body: parsed.data,
      C: parsed.data.C,
      payTx: settled.payTx,
    });

    reply.header("PAYMENT-RESPONSE", settled.responseHeader);
    await reply.code(outcome.status).send(outcome.body);
    fireAlarm(ctx, outcome);
    return reply;
  });
}

/**
 * The retry settled nothing, so `PAYMENT-RESPONSE` is rebuilt from the payment the release row
 * already records. The runner learns `pay_tx` *only* from this header (PROTOCOL §2) and the action
 * treats a 200 without one as a bug — which it would be. The transaction id is the one the first
 * answer carried, because it is the one on chain.
 */
async function answerFromRecord(
  ctx: WitnessContext,
  reply: FastifyReply,
  h: string,
  outcome: ReleaseOutcome,
): Promise<FastifyReply> {
  const payTx = ctx.repos.releases.get(h)?.pay_tx;
  if (outcome.status === 200 && payTx) {
    reply.header(
      "PAYMENT-RESPONSE",
      // No `payer`: that is the facilitator's word about a settlement, and no settlement happened.
      encodePaymentResponseHeader({
        success: true,
        transaction: payTx,
        network: ctx.config.X402_NETWORK as Network,
      }),
    );
  }
  await reply.code(outcome.status).send(outcome.body);
  return reply;
}

function pipelineDeps(ctx: WitnessContext): PipelineDeps {
  return {
    config: ctx.config,
    repos: ctx.repos,
    payment: ctx.payment,
    source: ctx.source,
    oidc: ctx.oidc,
    clock: ctx.clock,
    log: ctx.log,
    db: ctx.db,
    hcs: ctx.hcs,
  };
}

/**
 * D29: fired after the reply is on the wire, never awaited, never load-bearing. A refusal wakes the
 * operator; a release is a receipt. `status` is what tells them apart, so neither goes out as the
 * other.
 */
function fireAlarm(ctx: WitnessContext, outcome: ReleaseOutcome): void {
  if (outcome.status === 200) {
    if (outcome.alarm) ctx.alarm.released(outcome.alarm);
    return;
  }
  if (outcome.status === 403 && outcome.alarm) ctx.alarm.refused(outcome.alarm);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
