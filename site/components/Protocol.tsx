import { CHAIN, REFUSED, RELEASED, STOLEN, short } from "@/lib/facts";

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
          <span className="inline-block w-[150px] truncate align-bottom">{k}</span>
          <span className={hot ? "text-signal" : "text-steel-dim"}>{v}</span>
          {hot && <div className="pl-[150px] text-signal">← read by every step</div>}
        </div>
      ))}
      <div className="mt-3 text-ink-3">
        {"//"} {STOLEN.varsRead} variables. one of them ships money.
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
      <div className="my-1.5 text-steel-dim">{"       │ signed by the runner, not the witness"}</div>
      <div className="my-1.5 text-steel-dim">{"       ▼"}</div>
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
      <div className="mt-3 text-ink-3">{"// written to consensus BEFORE the answer"}</div>
    </pre>
  );
}

const CARDS = [
  {
    head: "a CI secret is ambient.",
    body: "A repository secret sits in the environment of every step, including a dependency's install script. Nothing records that it was read.",
    tag: "PLAIN SECRET  [ EVERY STEP · NO RECORD ]",
    panel: <PanelAmbient />,
  },
  {
    head: "the runner pays to ask.",
    body: "The runner signs a commitment naming the secret, the environment and the run, and pays the witness with its hash as the transaction memo. The request and the public record are one act.",
    tag: "COMMITMENT  [ MEMO ≡ HASH · CONSENSUS ]",
    panel: <PanelCommitment />,
  },
  {
    head: "the refusal is the receipt.",
    body: "Every decision reaches a Hedera topic before share B is returned. The witness cannot suppress it, and nobody can back-date it. A refusal is as permanent as a release.",
    tag: "PUBLIC RECORD  [ HCS · UNSUPPRESSIBLE ]",
    panel: <PanelRecord />,
  },
];

/* Three cards side by side at `lg`, each the statement and then the thing itself, so the whole
   argument is one screen. */
export function Protocol() {
  return (
    <section id="protocol" className="border-b border-rule">
      <div className="mx-auto max-w-[1280px] px-6 py-14 lg:py-16">
        <p className="gutter">the protocol</p>
        <h2 className="display mt-5 max-w-[30ch] text-[clamp(1.8rem,3vw,2.6rem)]">
          Three things have to be true
          <span className="lead-dim"> before a secret is allowed to open.</span>
        </h2>

        <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-3 lg:gap-6">
          {CARDS.map((c) => (
            <article
              key={c.head}
              className="flex flex-col rounded-2xl border border-rule bg-panel/50 p-6"
            >
              <h3 className="text-[clamp(1.25rem,1.5vw,1.45rem)] leading-tight font-bold">{c.head}</h3>
              <p className="mt-3 text-[14px] leading-relaxed text-ink-2">{c.body}</p>
              <p className="mt-4 font-mono text-[10.5px] tracking-[0.08em] text-steel-dim">{c.tag}</p>
              <div className="mt-5 flex-1 rounded-xl border border-rule bg-ground p-4">{c.panel}</div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
