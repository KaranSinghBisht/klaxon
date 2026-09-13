import { CHAIN, REFUSED, RELEASED, short } from "@/lib/facts";

/* Three panels of type, not pictures. Each is the real shape of the thing it describes: the
   environment a worm actually reads, the transfer that actually settles, the record that actually
   reaches consensus. Monospace because all three are things you are meant to check. */

function PanelAmbient() {
  const rows: [string, string, boolean][] = [
    ["CI", "true", false],
    ["GITHUB_REPOSITORY", "acme/payments", false],
    ["NODE_VERSION", "24.3.0", false],
    ["AWS_REGION", "eu-west-1", false],
    ["DEPLOYER_PRIVATE_KEY", "0x4f3a9c…e21b", true],
    ["npm_config_cache", "/home/runner/.npm", false],
    ["RUNNER_TEMP", "/home/runner/work/_temp", false],
    ["GITHUB_SHA", "bf02e05406422f91…", false],
  ];
  return (
    <pre className="overflow-x-auto font-mono text-[11px] leading-[1.85]">
      {rows.map(([k, v, hot]) => (
        <div key={k} className={hot ? "text-signal" : "text-ink-3"}>
          <span className="inline-block w-[220px] truncate">{k}</span>
          <span className={hot ? "text-signal" : "text-steel-dim"}>{v}</span>
          {hot && <span className="text-signal"> ← read by every step</span>}
        </div>
      ))}
      <div className="mt-3 text-ink-3">
        {"//"} {147} variables. one of them ships money.
      </div>
    </pre>
  );
}

function PanelCommitment() {
  return (
    <pre className="overflow-x-auto font-mono text-[11px] leading-[1.9] text-ink-3">
      <div className="text-signal">402 PAYMENT REQUIRED</div>
      <div>
        {"  "}payTo {"   "}
        <span className="text-steel-dim">{CHAIN.witnessAccount}</span>
      </div>
      <div>
        {"  "}amount{"  "}
        <span className="text-steel-dim">{CHAIN.priceTinybar} tinybar</span>
      </div>
      <div>
        {"  "}memo {"   "}
        <span className="text-ink">{short(RELEASED.commitment, 26, 8)}</span>
      </div>
      <div className="my-1.5 text-steel-dim">{"         │ signed by the runner, not the witness"}</div>
      <div className="my-1.5 text-steel-dim">{"         ▼"}</div>
      <div className="text-ink">TRANSFER SUCCESS</div>
      <div>
        {"  "}tx{"     "}
        <span className="text-steel-dim">{RELEASED.payTx}</span>
      </div>
      <div className="text-good">{"  memo ≡ commitment                      ✓"}</div>
    </pre>
  );
}

function PanelRecord() {
  const bar = (n: number) => "█".repeat(n);
  const rows: [string, string, string][] = [
    ["TYPE", "refused", "text-signal"],
    ["SECRET", bar(11), "text-steel-dim"],
    ["ENVIRONMENT", "(none declared)", "text-signal"],
    ["RUN", bar(6), "text-steel-dim"],
    ["CHECK", String(REFUSED.check), "text-signal"],
    ["PAID", `${CHAIN.priceHbar} ℏ`, "text-ink"],
    ["JWT", bar(14), "text-steel-dim"],
    ["SEQUENCE", `#${REFUSED.hcs}`, "text-ink"],
  ];
  return (
    <pre className="overflow-x-auto font-mono text-[11px] leading-[1.95]">
      {rows.map(([k, v, cls]) => (
        <div key={k} className="text-ink-3">
          <span className="inline-block w-[130px]">{k}</span>
          <span className={cls}>{v}</span>
        </div>
      ))}
      <div className="mt-3 text-ink-3">{"// written to consensus BEFORE the answer is returned"}</div>
    </pre>
  );
}

const CARDS = [
  {
    head: "a CI secret is ambient.",
    body: "A repository secret sits in the environment of every step in the job — including the one that runs a dependency's install script. Nothing in that picture records that it was read.",
    tag: "PLAIN SECRET  [ EVERY STEP · NO RECORD ]",
    panel: <PanelAmbient />,
    flip: false,
  },
  {
    head: "the runner pays to ask.",
    body: "The runner signs a commitment naming the secret, the environment and the run, hashes it, and pays the witness with that hash as the transaction memo. The request and the public record are the same act — you cannot perform one without the other.",
    tag: "COMMITMENT  [ MEMO ≡ HASH · CONSENSUS ]",
    panel: <PanelCommitment />,
    flip: true,
  },
  {
    head: "the refusal is the receipt.",
    body: "Every decision reaches a Hedera topic before share B is returned. The witness cannot suppress it, because it did not author it. Nobody can back-date it, because Hedera ordered it. A refusal is as permanent as a release.",
    tag: "PUBLIC RECORD  [ HCS · UNSUPPRESSIBLE ]",
    panel: <PanelRecord />,
    flip: false,
  },
];

export function Protocol() {
  return (
    <section id="protocol" className="border-b border-rule">
      <div className="mx-auto max-w-[1180px] px-6 py-20 sm:py-28">
        <p className="gutter">the protocol</p>
        <h2 className="display mt-6 max-w-[24ch] text-[clamp(1.9rem,4vw,3rem)]">
          Three things have to be true
          <span className="lead-dim"> before a secret is allowed to open.</span>
        </h2>

        <div className="mt-14 space-y-5">
          {CARDS.map((c) => (
            <article
              key={c.head}
              className="grid grid-cols-1 items-center gap-8 overflow-hidden rounded-2xl border border-rule bg-panel/50 p-7 sm:p-10 lg:grid-cols-2 lg:gap-12"
            >
              <div className={c.flip ? "lg:order-2" : ""}>
                <h3 className="text-[clamp(1.4rem,2.4vw,1.9rem)] leading-tight font-bold">
                  {c.head}
                </h3>
                <p className="mt-4 max-w-[46ch] text-[14.5px] leading-relaxed text-ink-2">
                  {c.body}
                </p>
                <p className="mt-6 font-mono text-[11px] tracking-[0.08em] text-steel-dim">
                  {c.tag}
                </p>
              </div>

              <div
                className={`rounded-xl border border-rule bg-ground p-5 sm:p-6 ${c.flip ? "lg:order-1" : ""}`}
              >
                {c.panel}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
