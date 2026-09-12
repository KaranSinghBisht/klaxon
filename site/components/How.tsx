import { CHAIN } from "@/lib/facts";

const STEPS = [
  {
    n: "01",
    head: "Split it, and put half in the open",
    body: "Share A is encrypted under your Ledger Key Ring and committed to the repository, in public. Share B never leaves the witness. Neither half is worth anything alone, so the thing in your repo is safe to lose.",
    tag: "Ledger Key Ring",
  },
  {
    n: "02",
    head: "Make the runner pay to ask",
    body: `The runner signs a commitment naming the secret, the environment and the run, hashes it, and pays ${CHAIN.priceHbar} ℏ on Hedera with that hash as the transaction memo. The request and the public record are the same act.`,
    tag: "x402 · Blocky402",
  },
  {
    n: "03",
    head: "Check who is really asking",
    body: "The witness verifies GitHub's OIDC token against a policy whose hash the owner's physical Ledger anchored on Sepolia. A job the policy does not name gets nothing, no matter what it holds.",
    tag: "GitHub OIDC · Sepolia",
  },
  {
    n: "04",
    head: "Publish before you answer",
    body: "The decision goes to a Hedera Consensus Service topic before share B is returned. The witness cannot suppress the record, because it did not write it, and cannot back-date it, because Hedera ordered it.",
    tag: "HCS",
  },
];

export function How() {
  return (
    <section id="how" className="border-b border-rule bg-ground-2">
      <div className="mx-auto max-w-[1040px] px-6 py-20 sm:py-24">
        <p className="gutter">what we built</p>
        <h2 className="display mt-4 max-w-[17ch] text-[clamp(2rem,4.6vw,3.3rem)] font-bold">
          A secret that has to ask, in public, before it opens.
        </h2>
        <p className="mt-6 max-w-[62ch] text-[16.5px] leading-relaxed text-ink-2">
          KLAXON does not try to stop a job from using a credential it was authorised to have. It
          makes the <span className="text-ink">first</span> read impossible to perform quietly, and
          it names exactly what was read, by which workflow, at which commit.
        </p>

        <ol className="mt-12 grid gap-3 sm:grid-cols-2">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-xl border border-rule bg-panel p-6">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[12px] font-semibold text-steel">{s.n}</span>
                <span className="gutter border border-rule bg-panel-2 px-2 py-0.5 text-steel">
                  {s.tag}
                </span>
              </div>
              <h3 className="mt-3 text-[17px] leading-snug font-semibold text-ink">{s.head}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-10 rounded-xl border border-rule border-l-2 border-l-signal bg-panel p-6">
          <p className="gutter text-signal">the one exception, said out loud</p>
          <p className="mt-2.5 max-w-[68ch] text-[15px] leading-relaxed text-ink-2">
            A job that was <span className="text-ink">already authorised</span> can read what it was
            authorised to receive. That is true of anything that hands a process a working
            credential, and pretending otherwise would be a lie you could check in ten minutes. What
            changes is that the read is no longer free, no longer silent, and no longer deniable.
          </p>
        </div>
      </div>
    </section>
  );
}
