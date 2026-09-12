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

function Line({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-rule-soft py-2.5 sm:flex-row sm:gap-4">
      <span className="w-[152px] shrink-0 font-mono text-[11px] text-ink-3 uppercase">{k}</span>
      <span className="font-mono text-[12.5px] break-all text-ink">{children}</span>
    </div>
  );
}

const link = "text-brass underline decoration-brass-line underline-offset-2 hover:brightness-125";

export function Evidence() {
  return (
    <section id="evidence" className="border-b border-rule">
      <div className="mx-auto max-w-[1040px] px-6 py-20 sm:py-24">
        <p className="gutter">evidence</p>
        <h2 className="display mt-4 max-w-[18ch] text-[clamp(2rem,4.6vw,3.3rem)] font-bold">
          Three runs. Same worm. Same secret.
        </h2>
        <p className="mt-6 max-w-[62ch] text-[16.5px] leading-relaxed text-ink-2">
          Every run below happened on a hosted GitHub runner, paid a real Hedera transaction, and
          left a record anyone can read. Click any of it.
        </p>

        <div className="mt-12 space-y-4">
          {/* 1 — the baseline */}
          <article className="overflow-hidden rounded-xl border border-rule border-l-2 border-l-signal bg-panel">
            <div className="flex flex-wrap items-center gap-3 px-6 pt-5">
              <span className="gutter border border-signal-line bg-signal-soft px-2 py-0.5 text-signal">
                stolen
              </span>
              <h3 className="text-[17px] font-semibold">An ordinary pipeline, an ordinary secret</h3>
            </div>
            <p className="px-6 pt-2.5 text-[14.5px] leading-relaxed text-ink-2">
              The deploy key is a normal GitHub Actions secret, so it sits in the environment of
              every step — including the one where a compromised dependency&apos;s install script
              runs. The worm read {STOLEN.varsRead} variables and found it in seconds.
            </p>
            <div className="px-6 pt-4 pb-5">
              <Line k="workflow run">
                <a className={link} href={runUrl(STOLEN.run)}>
                  {STOLEN.run}
                </a>
              </Line>
              <Line k="treasury it owns">
                <a className={link} href={etherscan(STOLEN.treasury)}>
                  {short(STOLEN.treasury, 14, 8)}
                </a>
              </Line>
              <Line k="controlled by">{short(STOLEN.owner, 14, 8)} — now a stolen key</Line>
            </div>
          </article>

          {/* 2 — the protected release */}
          <article className="overflow-hidden rounded-xl border border-rule border-l-2 border-l-good bg-panel">
            <div className="flex flex-wrap items-center gap-3 px-6 pt-5">
              <span className="gutter border border-good-line bg-good-soft px-2 py-0.5 text-good">
                released
              </span>
              <h3 className="text-[17px] font-semibold">The same pipeline, protected</h3>
            </div>
            <p className="px-6 pt-2.5 text-[14.5px] leading-relaxed text-ink-2">
              Half the key is committed to the repository in public. The deploy job pays, proves who
              it is, and is served — and the plaintext exists only inside that one step. The worm is
              still there. It reads the environment and finds nothing worth having.
            </p>
            <div className="px-6 pt-4 pb-5">
              <Line k="workflow run">
                <a className={link} href={runUrl(RELEASED.run)}>
                  {RELEASED.run}
                </a>
              </Line>
              <Line k="commitment">{short(RELEASED.commitment, 28, 10)}</Line>
              <Line k="hedera payment">
                <a className={link} href={hashscanTx(RELEASED.payTx)}>
                  {RELEASED.payTx}
                </a>{" "}
                <span className="text-good">— memo equals the commitment</span>
              </Line>
              <Line k="audit record">
                <a className={link} href={hashscanTopic(CHAIN.topic)}>
                  topic {CHAIN.topic}
                </a>{" "}
                · sequence #{RELEASED.hcs}
              </Line>
              <Line k="treasury deployed">
                <a className={link} href={etherscan(RELEASED.treasury)}>
                  {short(RELEASED.treasury, 14, 8)}
                </a>{" "}
                — owned by {short(PROTECTED_OWNER, 10, 6)}, a key that never leaked
              </Line>
            </div>
          </article>

          {/* 3 — the refusal */}
          <article className="overflow-hidden rounded-xl border border-rule border-l-2 border-l-signal bg-panel">
            <div className="flex flex-wrap items-center gap-3 px-6 pt-5">
              <span className="gutter border border-signal-line bg-signal-soft px-2 py-0.5 text-signal">
                refused
              </span>
              <h3 className="text-[17px] font-semibold">
                The attacker holds everything and runs it anyway
              </h3>
            </div>
            <p className="px-6 pt-2.5 text-[14.5px] leading-relaxed text-ink-2">
              The Key Ring credential, the payment key, the encrypted share, and a copy of the real
              release step — replayed from a job they control. The payment settles. Then the witness
              reads GitHub&apos;s own token, sees a job the policy never named, refuses, freezes the
              project, and the owner&apos;s phone goes off.
            </p>
            <div className="px-6 pt-4 pb-5">
              <Line k="workflow run">
                <a className={link} href={runUrl(REFUSED.run)}>
                  {REFUSED.run}
                </a>
              </Line>
              <Line k="paid anyway">
                <a className={link} href={hashscanTx(REFUSED.payTx)}>
                  {REFUSED.payTx}
                </a>{" "}
                — {CHAIN.priceHbar} ℏ, settled
              </Line>
              <Line k="refused at">
                <span className="text-signal">
                  check {REFUSED.check} — {REFUSED.reason}
                </span>
              </Line>
              <Line k="on the record">
                <a className={link} href={hashscanTopic(CHAIN.topic)}>
                  sequence #{REFUSED.hcs}
                </a>{" "}
                — carrying the attacker&apos;s own GitHub token
              </Line>
            </div>
          </article>
        </div>

        <p className="mt-8 text-[14px] leading-relaxed text-ink-3">
          The two treasuries are controlled by different keys on purpose. If they shared one, the
          protected balance staying untouched would prove nothing.
        </p>
      </div>
    </section>
  );
}
