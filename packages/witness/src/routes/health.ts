import type { FastifyInstance } from "fastify";
import type { WitnessContext } from "../context.js";

/**
 * PROTOCOL §2 — `{ok, db, facilitator, mirror, sepolia_cursor_lag_s}`, 503 if any check fails.
 *
 * Failing closed is deliberate: Fly stops routing to a machine whose health check is red, which is
 * the correct behaviour for a witness that cannot settle payments, cannot read the chain back, or
 * has fallen behind on Sepolia (B §7.3).
 *
 * All four are live: `db` runs a query, `facilitator` and `mirror` are probed over the wire by the
 * payment port on every call (cached for a few seconds), and the cursor lag is read from the
 * watcher. Nothing here reports a flag latched at boot — a witness that was healthy once is not a
 * witness that is healthy now.
 */
export const MAX_CURSOR_LAG_S = 300;

export function registerHealthRoute(app: FastifyInstance, ctx: WitnessContext): void {
  app.get("/health", async (_req, reply) => {
    const db = probeDb(ctx);
    const { facilitator, mirror } = await ctx.payment
      .health()
      .catch(() => ({ facilitator: false, mirror: false }));
    const lag = ctx.registry.lagSeconds();
    const cursorOk = lag === null ? false : lag <= MAX_CURSOR_LAG_S;
    const ok = db && facilitator && mirror && cursorOk;
    return reply.code(ok ? 200 : 503).send({
      ok,
      db,
      facilitator,
      mirror,
      sepolia_cursor_lag_s: lag,
    });
  });
}

function probeDb(ctx: WitnessContext): boolean {
  try {
    ctx.db.prepare("SELECT COUNT(*) AS n FROM projects").get();
    return true;
  } catch (err) {
    ctx.log.error({ err }, "database probe failed");
    return false;
  }
}
