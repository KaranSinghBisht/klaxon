import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/**
 * `GET /audit` — a page that reads the audit trail out of Hedera and re-checks, in the reader's
 * browser, that every payment memo really is the commitment hash in the matching record.
 *
 * The witness serves the HTML and nothing else: the page queries the public mirror node directly
 * and never calls back here, which is the property that matters. If this witness went down, or
 * started lying, the page would keep working and would say so. Serving it from the same host a
 * judge already has open is just convenience.
 *
 * Read once at boot. It is a few kilobytes and it never changes between deploys.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

function loadPage(): string {
  for (const candidate of [join(HERE, "audit.html"), join(HERE, "..", "public", "audit.html")]) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try the next layout: `dist/` when bundled, `src/` when running from source
    }
  }
  return "<!doctype html><title>KLAXON</title><p>Audit page not bundled in this build.</p>";
}

export function registerAuditRoute(app: FastifyInstance): void {
  const page = loadPage();
  app.get("/audit", async (_req, reply) =>
    reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(page),
  );
}
