const FACTS = [
  {
    stat: "76%",
    label: "of crypto stolen in H1 2026",
    body: "came from infrastructure and operational compromise — not smart-contract bugs — out of only about 15% of incidents. The losses are stolen credentials.",
  },
  {
    stat: "~700",
    label: "npm packages hit by Shai-Hulud 2.0",
    body: "in November 2025, spawning more than 25,000 malicious repositories. One leaked key from that campaign published a trojanised wallet extension.",
  },
  {
    stat: "$8.5M",
    label: "drained by that one extension",
    body: "because a credential that was read in CI is a credential nobody can prove was read at all.",
  },
];

export function Problem() {
  return (
    <section id="problem" className="border-b border-rule">
      <div className="mx-auto max-w-[1040px] px-6 py-20 sm:py-24">
        <p className="gutter">the problem</p>
        <h2 className="display mt-4 max-w-[15ch] text-[clamp(2rem,4.6vw,3.3rem)] font-bold">
          Your deploy key is a string in an environment variable.
        </h2>
        <p className="mt-6 max-w-[62ch] text-[16.5px] leading-relaxed text-ink-2">
          Every job in that workflow can read it, including the one that runs a dependency&apos;s
          install script. That is not a hypothetical: it is how the largest npm compromises of the
          last two years actually worked. And when it happens, the secret leaves silently. There is
          no record that it was read, no way to prove it wasn&apos;t, and nothing to tell you which
          run took it.
        </p>

        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {FACTS.map((f) => (
            <div key={f.stat} className="rounded-xl border border-rule bg-panel p-5">
              <p className="font-mono text-[30px] leading-none font-semibold text-signal tnum">
                {f.stat}
              </p>
              <p className="mt-2.5 text-[13.5px] font-semibold text-ink">{f.label}</p>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{f.body}</p>
            </div>
          ))}
        </div>

        <p className="mt-10 max-w-[62ch] text-[16.5px] leading-relaxed text-ink-2">
          Short-lived identity-bound credentials solve this where they exist, and where they exist
          you should use them. They do not exist for the sixty other tokens in a real pipeline: an
          Etherscan key, a Vercel token, a deployer private key. Those are long-lived strings sitting
          in a CI environment, and{" "}
          <span className="text-ink">when one is read, there is no record that it happened.</span>
        </p>
      </div>
    </section>
  );
}
