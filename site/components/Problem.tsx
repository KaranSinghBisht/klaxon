const FAILURES = [
  "A repository secret is in the environment of every step, including the one that runs a dependency's install script.",
  "Nothing records that a secret was read: not who, not which run, not whether it happened at all.",
  "The credential outlives the job. Copied out, it keeps working until a human notices and rotates it.",
  "Short-lived federated identity fixes this where it exists. It does not exist for an Etherscan key or a deployer private key.",
  "The blast radius is the whole pipeline: every job can read what any job can read.",
  "You find out from the chain, not from the pipeline — after the funds move.",
];

const SOURCED = [
  {
    stat: "76%",
    label: "of crypto stolen in H1 2026",
    body: "came from infrastructure and operational compromise, not contract bugs, out of only ~15% of incidents.",
  },
  {
    stat: "~700",
    label: "npm packages hit by Shai-Hulud 2.0",
    body: "in November 2025, spawning more than 25,000 malicious repositories from one campaign.",
  },
  {
    stat: "$8.5M",
    label: "drained by one trojanised extension",
    body: "published with a key that had been read in CI — a read nobody could prove had happened.",
  },
];

export function Problem() {
  return (
    <section id="problem" className="border-b border-rule">
      <div className="mx-auto max-w-[1280px] px-6 py-12 lg:py-14">
        <p className="gutter">the problem</p>

        <h2 className="display mt-5 max-w-[46ch] text-[clamp(1.8rem,3vw,2.6rem)]">
          Deploys got automated.
          <span className="lead-dim">
            {" "}
            Secrets did not. A deploy key is still a long-lived string in an environment variable,
            readable by anything the job runs, and nothing records the read.
          </span>
        </h2>

        <ol className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {FAILURES.map((f, i) => (
            <li
              key={f}
              className={`border-t border-rule px-1 py-5 sm:px-6 ${i % 2 === 1 ? "sm:border-l" : ""} ${i % 3 === 0 ? "lg:border-l-0" : "lg:border-l"}`}
            >
              <div className="flex gap-5">
                <span className="mt-[3px] font-mono text-[11px] text-steel-dim tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="max-w-[42ch] text-[15px] leading-relaxed text-ink-2">{f}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-rule bg-rule sm:grid-cols-3">
          {SOURCED.map((s) => (
            <div key={s.stat} className="bg-ground p-6">
              <p className="display text-[38px] leading-none font-medium text-signal tnum">
                {s.stat}
              </p>
              <p className="mt-3 text-[13.5px] font-semibold text-ink">{s.label}</p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{s.body}</p>
            </div>
          ))}
        </div>

        <p className="mt-6 max-w-[64ch] text-[13.5px] leading-relaxed text-ink-3">
          Every figure above is sourced in the repository. These losses are not contract exploits.
          They are credentials read by something that should never have been able to read them.
        </p>
      </div>
    </section>
  );
}
