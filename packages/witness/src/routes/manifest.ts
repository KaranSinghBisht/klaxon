import type { FastifyInstance } from "fastify";
import type { WitnessContext } from "../context.js";

/**
 * PROTOCOL §4 — `GET /.well-known/klaxon.json`. Doubles as the Hedera "agent discovery" surface
 * and the Bazantic manifest, and it is where `klaxon init` reads the witness's HCS submit key from
 * before it can create a topic the witness alone can write to.
 *
 * The unfiltered project list leaks the tenant list, which is fine for a single-tenant demo;
 * `?project=<id>` exists for a multi-tenant deployment.
 */
export function registerManifestRoute(app: FastifyInstance, ctx: WitnessContext): void {
  app.get("/.well-known/klaxon.json", async (req, reply) => {
    const filter = (req.query as { project?: string } | undefined)?.project;
    const price = ctx.payment.price();
    const projects = ctx.repos.projects
      .list()
      .filter((p) => !filter || p.project_id === filter)
      .map((p) => ({
        project_id: p.project_id,
        topic_id: p.topic_id,
        policy_hash: p.policy_hash,
        current_gen: String(p.current_gen),
        revoked: p.revoked !== 0,
      }));

    const first = projects[0];
    return reply.code(200).send({
      klaxon: 1,
      release_endpoint: `${ctx.config.KLAXON_PUBLIC_URL}/release/{h}`,
      price,
      facilitator: ctx.config.X402_FACILITATOR,
      hedera_account: ctx.config.witnessAccount,
      submit_key: ctx.hcs.submitKeyDer,
      memo_rule: "transaction memo MUST equal the commitment hash h",
      projects,
      verify: first
        ? `npx klaxon verify --topic ${first.topic_id} --witness ${ctx.config.witnessAccount} --registry ${ctx.config.KLAXON_REGISTRY}`
        : `npx klaxon verify --witness ${ctx.config.witnessAccount} --registry ${ctx.config.KLAXON_REGISTRY}`,
    });
  });
}
