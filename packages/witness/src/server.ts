import Fastify, { type FastifyInstance } from "fastify";
import type { WitnessContext } from "./context.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuditRoute } from "./routes/audit.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerManifestRoute } from "./routes/manifest.js";
import { registerReleaseRoutes } from "./routes/release.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Exact bytes as received — the member signature covers `sha256(body)` (PROTOCOL §2). */
    rawBody?: Buffer;
  }
}

/**
 * The app factory. It takes ports rather than building them, so the whole HTTP surface — including
 * the nine checks — runs in tests against fakes and an in-memory database with no network at all.
 */
export function buildServer(ctx: WitnessContext): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  // JSON is parsed from a retained buffer: re-serialising the parsed object would change the
  // bytes and break every member signature.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch (err) {
      done(err instanceof Error ? err : new Error("invalid JSON"), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    ctx.log.error({ err }, "unhandled request error");
    // Never leak a stack trace or an internal message to the caller.
    return reply.code(500).send({ ok: false, reason: "internal error" });
  });

  registerHealthRoute(app, ctx);
  registerManifestRoute(app, ctx);
  registerReleaseRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerAuditRoute(app);
  return app;
}
