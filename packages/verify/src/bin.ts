#!/usr/bin/env node
import { parseArgs } from "node:util";
import { VerifyInfraError, VerifyUsageError } from "./errors.js";
import { verify } from "./index.js";
import { DEFAULT_MIRROR_URL } from "./mirror/client.js";
import { DEFAULT_GRACE_SECONDS } from "./pair.js";
import { DEFAULT_SEPOLIA_RPC } from "./registry.js";
import { exitCodeFor, renderHuman } from "./report.js";

const USAGE = `klaxon-verify — re-derive a KLAXON release history from public data

  klaxon-verify --topic 0.0.X --witness 0.0.Y --registry 0xREG [options]

  --topic <0.0.X>      HCS topic the witness publishes to           (required)
  --witness <0.0.Y>    Hedera account the runners pay               (required)
  --registry <0x…>     KlaxonRegistry on Sepolia                    (required)
  --rpc <url>          Sepolia JSON-RPC        (default ${DEFAULT_SEPOLIA_RPC})
  --mirror <url>       Hedera mirror node      (default ${DEFAULT_MIRROR_URL})
  --since <s.n>        Only read from this consensus timestamp on
  --from-block <n>     First Sepolia block to scan for registry events
  --grace <seconds>    Silence tolerated before WITHHELD (default ${DEFAULT_GRACE_SECONDS})
  --json               Emit the machine-readable report instead of the block
  --help               This text

Exit codes: 0 clean · 1 violations found · 2 the read could not complete.
`;

function fail(message: string, code: 1 | 2): never {
  process.stderr.write(`klaxon-verify: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: false });
  } catch (error) {
    process.stderr.write(`${USAGE}\n`);
    fail(error instanceof Error ? error.message : String(error), 2);
  }
  const values = parsed.values;

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const topic = values.topic;
  const witness = values.witness;
  const registry = values.registry;
  if (!topic || !witness || !registry) {
    process.stderr.write(`${USAGE}\n`);
    fail("--topic, --witness and --registry are all required", 2);
  }

  const grace = values.grace === undefined ? DEFAULT_GRACE_SECONDS : Number(values.grace);
  if (!Number.isFinite(grace) || grace < 0) fail(`--grace must be a non-negative number`, 2);
  const fromBlock = values["from-block"] === undefined ? undefined : BigInt(values["from-block"]);

  const report = await verify({
    topicId: topic,
    witnessAccount: witness,
    registryAddress: registry,
    ...(values.rpc ? { rpcUrl: values.rpc } : {}),
    ...(values.mirror ? { mirrorUrl: values.mirror } : {}),
    ...(values.since ? { sinceTimestamp: values.since } : {}),
    ...(fromBlock !== undefined ? { fromBlock } : {}),
    graceSeconds: grace,
  });

  process.stdout.write(
    values.json ? `${JSON.stringify(report, replacer, 2)}\n` : renderHuman(report),
  );
  process.exit(exitCodeFor(report));
}

const OPTIONS = {
  topic: { type: "string" },
  witness: { type: "string" },
  registry: { type: "string" },
  rpc: { type: "string" },
  mirror: { type: "string" },
  since: { type: "string" },
  "from-block": { type: "string" },
  grace: { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

/** `max_releases` limits and block numbers travel as BigInt; JSON needs them as strings. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

main().catch((error: unknown) => {
  if (error instanceof VerifyUsageError) fail(error.message, 2);
  if (error instanceof VerifyInfraError) {
    fail(`${error.message}${error.cause_ instanceof Error ? `: ${error.cause_.message}` : ""}`, 2);
  }
  fail(error instanceof Error ? error.message : String(error), 2);
});
