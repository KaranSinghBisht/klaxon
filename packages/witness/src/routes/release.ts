import { CommitmentSchema } from "@klaxon/core";
import { encodePaymentResponseHeader } from "@x402/core/http";
import type { Network } from "@x402/core/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PipelineDeps, ReleaseOutcome } from "../checks/pipeline.js";
import { replayRelease, runRelease } from "../checks/pipeline.js";
import type { WitnessContext } from "../context.js";
import { FixedWindowLimiter } from "../http/rate-limit.js";
import { MAX_CURSOR_LAG_S } from "./health.js";

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

/**
 * The witness applies policy it learned by following Sepolia. If the watcher has fallen behind, the
 * policy, the generation and above all the revocation flag may all be stale — so a project the owner
 * revoked minutes ago can still be served. `/health` already refuses to go green on this, but health
 * is only advice: nothing in front of this process is obliged to act on it, and the deployed Caddy
 * simply proxies. So the release path enforces it itself.
 *
 * Checked before settlement on purpose. A runner must never be charged for a request the witness
 * already knows it cannot answer, and `infra` is the honest class: nothing about the operator's
 * policy has been broken, so nothing is revoked and nothing is published.
 */
/**
 * Answering a release costs the witness roughly 32x what it charges, because the audit record is
 * chunked across three HCS submits. Unmetered, that turns every refusal a stranger can provoke into
 * an amplification attack on the operator's balance, and check 7's budget covers successful releases
 * only. Generous enough that no honest CI fleet notices; low enough that a script does.
 */
const RELEASE_RATE_LIMIT = Number(process.env.KLAXON_RELEASE_RATE_LIMIT ?? 60);
const RELEASE_RATE_WINDOW_MS = Number(process.env.KLAXON_RELEASE_RATE_WINDOW_MS ?? 60_000);

function registryStale(ctx: WitnessContext): number | null {
  const lag = ctx.registry.lagSeconds();
  if (lag === null || lag > MAX_CURSOR_LAG_S) return lag ?? -1;
  return null;
}

export function registerReleaseRoutes(app: FastifyInstance, ctx: WitnessContext): void {
  const limiter = new FixedWindowLimiter({
    limit: RELEASE_RATE_LIMIT,
    windowMs: RELEASE_RATE_WINDOW_MS,
  });

  /** Refuses before any work, any chain read and any settlement. Returns true when it answered. */
  const limited = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const verdict = limiter.take(req.ip);
    if (verdict.allowed) return false;
    ctx.log.warn({ ip: req.ip }, "release rate limit exceeded");
    reply
      .code(429)
      .header("retry-after", String(verdict.retryAfterS))
      .send({ ok: false, class: "infra", check: 0, reason: "too many release requests" });
    return true;
  };

  app.get<{ Params: { h: string } }>("/release/:h", async (req, reply) => {
    if (limited(req, reply)) return reply;
    const h = req.params.h.toLowerCase();
    if (!H_PARAM.test(h)) {
      return reply.code(400).send({ ok: false, reason: "h must be 64 lowercase hex characters" });
    }
    const stale = registryStale(ctx);
    if (stale !== null) {
      ctx.log.error({ h, lag_s: stale }, "refusing to quote: registry watcher is stale");
      return reply
        .code(503)
        .send({ ok: false, h, class: "infra", check: 0, reason: "registry watcher is stale" });
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
    if (limited(req, reply)) return reply;
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

    const stalePost = registryStale(ctx);
    if (stalePost !== null) {
      ctx.log.error({ h, lag_s: stalePost }, "refusing to release: registry watcher is stale");
      return reply
        .code(503)
        .send({ ok: false, h, class: "infra", check: 0, reason: "registry watcher is stale" });
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
