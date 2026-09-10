/**
 * Gate B — prove a release memo survives the Blocky402 testnet facilitator, end to end.
 *
 * No fakes. It stands up the witness's real x402 path (`X402PaymentAdapter`) behind a tiny local
 * server, has a runner pay through https://api.testnet.blocky402.com with the same wiring the
 * action uses (`buildPayClient` + `wrapFetchWithPayment`), then reads the settled transaction back
 * off the Hedera mirror node and asserts `memo_base64 == h` and the witness was credited. This is
 * the build plan's Gate B: if a memo'd transfer does not round-trip Blocky402, the
 * payment-as-commitment binding does not hold and the design changes.
 *
 * Lives in the action package because it has every @x402 dependency; the witness adapter it imports
 * resolves its own deps from the witness package.
 *
 * Run (ECDSA keys, 0x-prefixed):
 *   HEDERA_OPERATOR_ID=0.0.<witness>  KLAXON_PAY_ACCOUNT=0.0.<runner> KLAXON_PAY_KEY=0x<runner-ecdsa> \
 *   pnpm --filter @klaxon/action exec tsx scripts/gate-b.ts
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { PrivateKey } from "@x402/hedera";
import { X402PaymentAdapter } from "../../witness/src/adapters/payment-x402.js";
import { buildPayClient } from "../src/client.js";

const FACILITATOR = process.env.X402_FACILITATOR ?? "https://api.testnet.blocky402.com";
const MIRROR = process.env.MIRROR_NODE ?? "https://testnet.mirrornode.hedera.com";
const NETWORK = "hedera:testnet";
const ASSET = "0.0.0"; // native HBAR
const PRICE = process.env.X402_PRICE_TINYBAR ?? "100000"; // 0.001 ℏ, in tinybars
const PORT = 8788;
const PUBLIC_URL = `http://127.0.0.1:${PORT}`;

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Gate B: ${name} is required`);
    process.exit(2);
  }
  return v;
}

// The witness only RECEIVES, so its account id (the payee) is all we need from that side; the
// facilitator submits and pays the network fee. The runner needs its account + ECDSA key to sign.
const witnessAccount = need("HEDERA_OPERATOR_ID");
const payAccount = need("KLAXON_PAY_ACCOUNT");
const payKey = need("KLAXON_PAY_KEY");

// Minimal shape of WitnessConfig — only the fields X402PaymentAdapter reads.
const config = {
  X402_FACILITATOR: FACILITATOR,
  X402_NETWORK: NETWORK,
  X402_ASSET: ASSET,
  X402_PRICE_TINYBAR: PRICE,
  X402_MAX_TIMEOUT_S: 120,
  witnessAccount,
  MIRROR_NODE: MIRROR,
  KLAXON_PUBLIC_URL: PUBLIC_URL,
  // biome-ignore lint/suspicious/noExplicitAny: a gate harness passes only the fields the adapter uses
} as any;

const log = {
  info() {},
  debug() {},
  warn: (...a: unknown[]) => console.error("[warn]", ...a),
  error: (...a: unknown[]) => console.error("[error]", ...a),
  // biome-ignore lint/suspicious/noExplicitAny: a two-method logger is all the adapter calls
} as any;

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function main(): Promise<void> {
  const h = randomBytes(32).toString("hex");
  console.log(`Gate B: commitment h        = ${h}`);
  console.log(`Gate B: facilitator         = ${FACILITATOR}`);
  console.log(`Gate B: payer  (runner)     = ${payAccount}`);
  console.log(`Gate B: payee  (witness)    = ${witnessAccount}`);
  console.log(`Gate B: price               = ${PRICE} tinybar\n`);

  const adapter = new X402PaymentAdapter(config, log);
  console.log("Gate B: fetching Blocky402 /supported (facilitator handshake)…");
  await adapter.initialize();
  console.log("Gate B: facilitator ready, extra.feePayer injected.\n");

  // The witness's 402 path, behind a tiny server: a 402 with extra.memo=h, then verify+settle.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const sig = headerValue(req.headers["payment-signature"]);
      if (!sig) {
        const ans = await adapter.buildRequirements(h);
        res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": ans.header });
        res.end(JSON.stringify(ans.body));
        return;
      }
      const settled = await adapter.verifyAndSettle(h, sig);
      if (!settled.ok) {
        res.writeHead(settled.infra ? 503 : 403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: settled.reason }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": settled.responseHeader,
      });
      res.end(JSON.stringify({ ok: true, payTx: settled.payTx, payer: settled.payer }));
    })().catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  // The runner pays — the exact client the action ships.
  const client = buildPayClient({
    payAccount,
    payKey: PrivateKey.fromStringECDSA(payKey),
    witnessAccount,
    maxTinybars: "1000000",
  });
  const payFetch = wrapFetchWithPayment(fetch, client);

  console.log("Gate B: runner pays the 402 (402 → memo-stamped transfer → settle)…");
  const res = await payFetch(`${PUBLIC_URL}/release/${h}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ h }),
  });
  const body = (await res.json()) as { ok: boolean; payTx?: string; reason?: string };
  if (!res.ok || !body.ok || !body.payTx) {
    console.error(`\nGATE B FAILED at settlement: ${res.status} ${body.reason ?? ""}`);
    server.close();
    process.exit(1);
  }
  console.log(`Gate B: settled. pay_tx     = ${body.payTx}\n`);

  // Read it back off the mirror node — the memo is the proof. Poll for indexing lag.
  console.log("Gate B: reading the transaction back off the mirror node…");
  let outcome: Awaited<ReturnType<X402PaymentAdapter["verifySettledOnChain"]>> | undefined;
  for (let i = 0; i < 12; i++) {
    outcome = await adapter.verifySettledOnChain(body.payTx, {
      memo: h,
      toAccount: witnessAccount,
      minAmount: PRICE,
    });
    if (outcome.ok || !outcome.infra) break;
    process.stdout.write(`  not indexed yet (${outcome.reason}); retrying…\n`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  server.close();

  if (!outcome?.ok) {
    console.error(`\nGATE B FAILED: ${outcome?.reason ?? "no outcome"}`);
    process.exit(1);
  }
  console.log("\n──────────────────────────────────────────────");
  console.log("GATE B PASSED: memo survived Blocky402, witness credited");
  console.log(`  memo_base64 decodes to h  ✓  (${h.slice(0, 12)}…)`);
  console.log(`  credited to witness       ✓  ${outcome.amount} tinybar → ${witnessAccount}`);
  console.log(`  debited from runner       ✓  ${outcome.payerAccount}`);
  console.log(`  consensus timestamp          ${outcome.consensusTimestamp}`);
  console.log(`  mirror                       ${MIRROR}/api/v1/transactions/${body.payTx}`);
  console.log("──────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("\nGATE B FAILED:", err);
  process.exit(1);
});
