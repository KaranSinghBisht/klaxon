import { CHAIN, REFUSED, RELEASED, short } from "@/lib/facts";

/* The four mocks below are not illustrations of an idea — each is a real fragment of the real flow:
   the file that is actually committed, the 402 the witness actually answers, the claim the OIDC
   token actually carries, and the record that actually reached consensus. */

function MockEnc() {
  return (
    <div className="rounded-lg border border-rule bg-panel p-3.5 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)]">
      <div className="flex items-center gap-2 border-b border-rule-soft pb-2.5">
        <span className="font-mono text-[10.5px] text-ink">DEPLOYER_PRIVATE_KEY.enc</span>
        <span className="gutter ml-auto border border-rule px-1.5 py-0.5">in git</span>
      </div>
      <dl className="mt-2.5 space-y-1.5 font-mono text-[9.5px]">
        <div className="flex gap-2">
          <dt className="w-[52px] shrink-0 text-ink-3">share_a</dt>
          <dd className="truncate text-ink-2">U8uM49yaFgrre459Z30iDWLB…</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-[52px] shrink-0 text-ink-3">key</dt>
          <dd className="truncate text-ink-2">wallet-cli-domain-v1</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-[52px] shrink-0 text-ink-3">b_hash</dt>
          <dd className="truncate text-ink-2">ea799b3e9de6ceaa…</dd>
        </div>
      </dl>
      <p className="mt-2.5 border-t border-rule-soft pt-2 text-[10.5px] text-ink-3">
        Public. Worthless without share B.
      </p>
    </div>
  );
}

function MockPay() {
  return (
    <div className="rounded-lg border border-rule bg-panel p-3.5 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)]">
      <div className="flex items-center gap-2 border-b border-rule-soft pb-2.5">
        <span className="font-mono text-[10.5px] font-semibold text-signal">402</span>
        <span className="font-mono text-[10.5px] text-ink-2">Payment Required</span>
      </div>
      <dl className="mt-2.5 space-y-1.5 font-mono text-[9.5px]">
        <div className="flex gap-2">
          <dt className="w-[46px] shrink-0 text-ink-3">payTo</dt>
          <dd className="text-ink-2">{CHAIN.witnessAccount}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-[46px] shrink-0 text-ink-3">amount</dt>
          <dd className="text-ink-2">{CHAIN.priceTinybar} tinybar</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-[46px] shrink-0 text-ink-3">memo</dt>
          <dd className="truncate text-ink">{short(RELEASED.commitment, 14, 6)}</dd>
        </div>
      </dl>
      <p className="mt-2.5 border-t border-rule-soft pt-2 text-[10.5px] text-ink-3">
        The memo <span className="text-ink">is</span> the commitment.
      </p>
    </div>
  );
}

function MockClaims() {
  return (
    <div className="rounded-lg border border-rule bg-panel p-3.5 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)]">
      <div className="flex items-center gap-2 border-b border-rule-soft pb-2.5">
        <span className="gutter border border-rule px-1.5 py-0.5">github oidc</span>
        <span className="ml-auto font-mono text-[9.5px] text-good">signature ok</span>
      </div>
      <p className="mt-2.5 font-mono text-[9.5px] leading-relaxed break-all text-ink-2">
        <span className="text-ink-3">sub:</span> repo:KaranSinghBisht/klaxon-demo@1366574220:
        <span className="text-good">environment:production</span>
      </p>
      <p className="mt-2.5 border-t border-rule-soft pt-2 text-[10.5px] text-ink-3">
        GitHub says who is asking. The policy says who may.
      </p>
    </div>
  );
}

function MockRecord() {
  return (
    <div className="rounded-lg border border-rule border-l-2 border-l-signal bg-panel p-3.5 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)]">
      <div className="flex items-center gap-2 border-b border-rule-soft pb-2.5">
        <span className="gutter border border-signal-line bg-signal-soft px-1.5 py-0.5 text-signal">
          refused
        </span>
        <span className="ml-auto font-mono text-[9.5px] text-ink-3">hcs #{REFUSED.hcs}</span>
      </div>
      <p className="mt-2.5 text-[11px] leading-snug text-signal">
        check {REFUSED.check} — {REFUSED.reason}
      </p>
      <p className="mt-2 font-mono text-[9.5px] text-ink-3">
        paid {CHAIN.priceHbar} ℏ · project revoked
      </p>
      <p className="mt-2.5 border-t border-rule-soft pt-2 text-[10.5px] text-ink-3">
        Written before the answer, to a ledger we do not own.
      </p>
    </div>
  );
}

const STEPS = [
  {
    n: "01",
    head: "Split",
    mock: <MockEnc />,
    body: "Share A is encrypted under your Ledger Key Ring and committed in public. Share B never leaves the witness. Neither half is worth anything alone.",
  },
  {
    n: "02",
    head: "Pay to ask",
    mock: <MockPay />,
    body: "The runner signs a commitment naming the secret, the environment and the run, and pays on Hedera with its hash as the memo. Asking and going on record are one act.",
  },
  {
    n: "03",
    head: "Prove who",
    mock: <MockClaims />,
    body: "The witness checks GitHub's OIDC token against a policy the owner's Ledger anchored on Sepolia. A job the policy does not name gets nothing, whatever else it holds.",
  },
  {
    n: "04",
    head: "Publish first",
    mock: <MockRecord />,
    body: "The decision reaches a Hedera topic before share B is returned. The witness did not write it, so it cannot suppress it. Hedera ordered it, so nobody can back-date it.",
  },
];

/* Hairlines between the steps: one column on phones, two at `sm`, four at `lg`. A rule goes on the
   left of every cell that is not first in its row and on top of every cell that starts a new row,
   and that is a different set of cells at each width. */
function stepRules(i: number): string {
  const top = i > 0 ? "border-t" : "";
  const sm = i === 1 ? "sm:border-t-0 sm:border-l" : i === 3 ? "sm:border-l" : "";
  const lg = i >= 2 ? "lg:border-t-0 lg:border-l" : "";
  return `${top} ${sm} ${lg}`;
}

export function How() {
  return (
    <section id="how" className="border-b border-rule bg-ground-2">
      <div className="mx-auto max-w-[1280px] px-6 py-12">
        <p className="gutter">what we built</p>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
          <h2 className="display max-w-[20ch] text-[clamp(1.8rem,3vw,2.6rem)]">
            A secret that has to ask, in public, before it opens.
          </h2>
          <p className="max-w-[52ch] text-[15.5px] leading-relaxed text-ink-2 lg:pt-2">
            KLAXON does not stop an authorised job using its credential. It makes the{" "}
            <span className="text-ink">first</span> read impossible to do quietly, and names what was
            read, by which workflow, at which commit. Every panel below is a real fragment of a real
            run.
          </p>
        </div>

        <ol className="mt-8 grid grid-cols-1 border-t border-rule sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li
              key={s.n}
              className={`flex flex-col border-rule sm:row-span-2 sm:grid sm:grid-rows-subgrid ${stepRules(i)}`}
            >
              <div className="hatch flex items-center border-b border-rule p-5">{s.mock}</div>
              <div className="p-5">
                <p className="flex items-baseline gap-2.5">
                  <span className="font-mono text-[11px] text-steel-dim tabular-nums">{s.n}</span>
                  <span className="display text-[20px] text-ink">{s.head}</span>
                </p>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-8 border-l-2 border-l-signal bg-panel/60 py-5 pr-6 pl-6">
          <p className="gutter text-signal">the one exception, said out loud</p>
          <p className="mt-2.5 max-w-[70ch] text-[14.5px] leading-relaxed text-ink-2">
            An <span className="text-ink">authorised</span> job can read what it was authorised to
            receive. That is true of anything that hands a process a working credential. What changes
            is that the read is no longer free, silent, or deniable.
          </p>
        </div>
      </div>
    </section>
  );
}
