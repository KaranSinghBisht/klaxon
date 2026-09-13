import {
  CHAIN,
  PROTECTED_OWNER,
  REFUSED,
  RELEASED,
  STOLEN,
  etherscan,
  hashscanTopic,
  hashscanTx,
  runUrl,
  short,
} from "@/lib/facts";

const link = "text-ink underline decoration-steel-dim/50 underline-offset-2 hover:text-steel";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-rule-soft py-2 sm:flex-row sm:gap-3">
      <span className="w-[104px] shrink-0 font-mono text-[10px] tracking-[0.07em] text-ink-3 uppercase">
        {k}
      </span>
      <span className="font-mono text-[11.5px] break-words text-ink-2">{children}</span>
    </div>
  );
}

type FigProps = {
  fig: string;
  verdict: string;
  verdictClass: string;
  head: string;
  body: string;
  children: React.ReactNode;
};

function Fig({ fig, verdict, verdictClass, head, body, children }: FigProps) {
  return (
    /* At `lg` the three figures share four grid rows — label, panel, verdict, caption — so the
       panels are one height and the captions sit on one line, whatever each one holds. The panel
       carries the data; the card carries no colour, so the verdict chip alone says which this is. */
    <article className="flex flex-col lg:row-span-4 lg:grid lg:grid-rows-subgrid">
      <p className="gutter">{fig}</p>
      <div className="mt-3 rounded-xl border border-rule bg-panel/40 p-5">{children}</div>
      <p className="mt-5 flex flex-wrap items-center gap-2.5">
        <span className={`gutter border px-2 py-0.5 ${verdictClass}`}>{verdict}</span>
        <span className="text-[15.5px] font-semibold text-ink">{head}</span>
      </p>
      <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">{body}</p>
    </article>
  );
}

export function Evidence() {
  return (
    <section id="evidence" className="border-b border-rule bg-ground-2">
      <div className="mx-auto max-w-[1280px] px-6 py-14 lg:py-16">
        <p className="gutter">evidence</p>
        <h2 className="display mt-5 max-w-[38ch] text-[clamp(1.8rem,3vw,2.6rem)]">
          Three runs, one worm, one secret.
          <span className="lead-dim">
            {" "}
            All on hosted GitHub runners, all paid for on Hedera, all on the record. Click any of it.
          </span>
        </h2>

        <div className="mt-10 grid gap-8 lg:grid-cols-3 lg:gap-x-6 lg:gap-y-0">
          <Fig
            fig="fig 0.1 — the baseline"
            verdict="stolen"
            verdictClass="border-signal-line bg-signal-soft text-signal"
            head="An ordinary pipeline"
            body="The deploy key is an ordinary Actions secret, so a compromised dependency's install script reads it like anything else."
          >
            <Row k="run">
              <a className={link} href={runUrl(STOLEN.run)}>
                {STOLEN.run}
              </a>
            </Row>
            <Row k="treasury">
              <a className={link} href={etherscan(STOLEN.treasury)}>
                {short(STOLEN.treasury, 12, 6)}
              </a>
            </Row>
            <Row k="owner">{short(STOLEN.owner, 12, 6)}</Row>
            <Row k="outcome">
              <span className="text-signal">key exfiltrated in seconds</span>
            </Row>
          </Fig>

          <Fig
            fig="fig 0.2 — protected"
            verdict="released"
            verdictClass="border-good-line bg-good-soft text-good"
            head="The same pipeline, split"
            body="Half the key is public. The deploy job pays, proves who it is, and is served. The worm is still there, and finds nothing."
          >
            <Row k="run">
              <a className={link} href={runUrl(RELEASED.run)}>
                {RELEASED.run}
              </a>
            </Row>
            <Row k="commitment">{short(RELEASED.commitment, 18, 6)}</Row>
            <Row k="payment">
              <a className={link} href={hashscanTx(RELEASED.payTx)}>
                {short(RELEASED.payTx, 20, 8)}
              </a>
            </Row>
            <Row k="binding">
              <span className="text-good">memo ≡ commitment</span>
            </Row>
            <Row k="record">
              <a className={link} href={hashscanTopic(CHAIN.topic)}>
                seq #{RELEASED.hcs}
              </a>
            </Row>
            <Row k="owner">{short(PROTECTED_OWNER, 12, 6)} — never leaked</Row>
          </Fig>

          <Fig
            fig="fig 0.3 — the attempt"
            verdict="refused"
            verdictClass="border-signal-line bg-signal-soft text-signal"
            head="Everything stolen, run anyway"
            body="Every credential, replayed from a job the attacker controls. The payment settles. The witness reads GitHub's own token and refuses."
          >
            <Row k="run">
              <a className={link} href={runUrl(REFUSED.run)}>
                {REFUSED.run}
              </a>
            </Row>
            <Row k="commitment">{short(REFUSED.commitment, 18, 6)}</Row>
            <Row k="paid">
              <a className={link} href={hashscanTx(REFUSED.payTx)}>
                {CHAIN.priceHbar} ℏ settled
              </a>
            </Row>
            <Row k="refused">
              <span className="text-signal">check {REFUSED.check} — no environment</span>
            </Row>
            <Row k="record">
              <a className={link} href={hashscanTopic(CHAIN.topic)}>
                seq #{REFUSED.hcs}
              </a>{" "}
              — carries their own token
            </Row>
            <Row k="then">
              <span className="text-signal">project revoked</span>
            </Row>
          </Fig>
        </div>

        <p className="mt-8 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-3">
          The two treasuries use different keys on purpose. With a shared key, an untouched protected
          balance would prove nothing.
        </p>
      </div>
    </section>
  );
}
