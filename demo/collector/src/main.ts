import Fastify from "fastify";
import { z } from "zod";
import { bigBlock } from "./bigtext.ts";

/**
 * The exfiltration sink — the attacker's machine, on camera.
 *
 * The demo worm reads `process.env` inside a GitHub Actions job and POSTs it here. Everything
 * this server does is theatre: it takes whatever it is handed and paints it in block type large
 * enough to read from across the room, so a stolen secret is unmistakable on film. It is the
 * "before" half of the demo — the world KLAXON is arguing against — and it is deliberately dumb:
 * no auth, no storage, no cleverness. Behind `cloudflared tunnel` it gets a public URL the
 * worm can reach from a hosted runner.
 *
 * It never runs in CI and holds nothing of value; the only secrets it ever sees are the demo's
 * own throwaway Sepolia key.
 */

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

/** Terminal columns to wrap block type at; a stolen 64-hex key wraps rather than scrolling off. */
const WIDTH = Number(process.env.COLLECTOR_WIDTH ?? 120);

/** Keys worth calling out in the demo. Everything received is printed; these get a banner. */
const INTERESTING = /KEY|SECRET|TOKEN|PASS|MNEMONIC|SEED|PRIVATE|DEPLOYER/i;

const LootSchema = z
  .object({
    source: z.string().max(200).optional(),
    env: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function banner(char: string): string {
  return char.repeat(Math.min(WIDTH, 120));
}

function paint(name: string, value: string): void {
  const hot = INTERESTING.test(name);
  process.stdout.write(`\n${hot ? RED + BOLD : DIM}${banner("=")}${RESET}\n`);
  process.stdout.write(`${hot ? RED + BOLD : ""}${name}${RESET}\n`);
  const color = hot ? RED : GREEN;
  process.stdout.write(color + bigBlock(value, WIDTH).join("\n") + RESET + "\n");
}

function printLoot(source: string, env: Record<string, string>): void {
  const names = Object.keys(env);
  const hits = names.filter((n) => INTERESTING.test(n));
  process.stdout.write(`\n${RED}${BOLD}${banner("#")}${RESET}\n`);
  process.stdout.write(
    `${RED}${BOLD}  EXFILTRATED  ${new Date().toISOString()}  from ${source}${RESET}\n`,
  );
  process.stdout.write(`${RED}  ${names.length} variables, ${hits.length} interesting${RESET}\n`);
  // Interesting names first and large; everything else as a compact list so the frame is not
  // buried under PATH and RUNNER_OS.
  for (const name of hits) paint(name, env[name] ?? "");
  const rest = names.filter((n) => !INTERESTING.test(n)).sort();
  if (rest.length > 0) {
    process.stdout.write(`\n${DIM}also captured: ${rest.join(", ")}${RESET}\n`);
  }
}

export function buildServer(): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false, bodyLimit: 5_000_000 });

  app.get("/health", async () => ({ ok: true }));

  app.post("/collect", async (req, reply) => {
    const parsed = LootSchema.safeParse(req.body);
    if (!parsed.success) {
      // A real sink would take anything; we validate only so a malformed body cannot crash the
      // one process the whole "before" shot depends on.
      const raw = JSON.stringify(req.body);
      printLoot("unparsed", { RAW_BODY: raw.slice(0, 2000) });
      return reply.code(200).send({ ok: true });
    }
    const { source, env } = parsed.data;
    printLoot(source ?? "unknown", env);
    return reply.code(200).send({ ok: true, received: Object.keys(env).length });
  });

  return app;
}

async function main(): Promise<void> {
  const app = buildServer();
  await app.listen({ port: PORT, host: HOST });
  process.stdout.write(
    `${DIM}collector listening on http://${HOST}:${PORT}/collect — waiting for the worm${RESET}\n`,
  );
}

// Run only when invoked directly, so tests can import `buildServer` without binding a port.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`collector failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
