import { CHAIN, REFUSED, STOLEN } from "@/lib/facts";
import { Veil } from "./Veil";

/* Three numbers from the runs themselves. */
const STATS = [
  {
    n: String(STOLEN.varsRead),
    unit: "",
    tone: "text-signal",
    body: "variables a compromised dependency read in the unprotected pipeline. One was the deploy key.",
  },
  {
    n: CHAIN.priceHbar,
    unit: "ℏ",
    tone: "text-ink",
    body: `paid on Hedera by an attacker holding every credential. Refused at check ${REFUSED.check}, on the record.`,
  },
  {
    n: "0",
    unit: "",
    tone: "text-good",
    body: "secrets the same worm got out of the protected pipeline, across every run.",
  },
];

/* The first scene. On a wide screen it fills exactly the viewport under the nav, copy on the left
   and the product on the right, so at 1920×1080 nothing has to scroll to be seen. Narrower than
   `lg` it stacks, and simply takes the height it needs. */
export function Hero() {
  return (
    <section className="veil relative overflow-hidden border-b border-rule lg:flex lg:min-h-[calc(100vh-57px)] lg:items-center">
      <Veil />

      <div className="veil-content mx-auto grid w-full max-w-[1240px] grid-cols-1 gap-12 px-6 py-14 lg:grid-cols-[minmax(0,10fr)_minmax(0,11fr)] lg:items-center lg:gap-12 lg:py-10">
        <div>
          <p className="inline-flex items-center gap-2 font-mono text-[11px] text-ink-3">
            <span aria-hidden className="relative flex h-2 w-2">
              <span className="alarm absolute inline-flex h-full w-full rounded-full bg-signal" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-signal" />
            </span>
            witness live · topic {CHAIN.topic} · settled through {CHAIN.facilitator}
          </p>

          <h1 className="display mt-5 max-w-[13ch] text-[clamp(2.5rem,4.6vw,4.8rem)]">
            Take all of it. You still can&apos;t use it.
          </h1>

          <p className="mt-6 max-w-[50ch] text-[16.5px] leading-relaxed text-ink-2">
            Steal the encrypted share, the Ledger credential, the payment key and the release step.
            The secret still opens only inside the one job the owner authorised — and every attempt
            leaves a receipt nobody can delete.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="#evidence"
              className="rounded-lg bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-ground transition hover:brightness-95"
            >
              See it actually happen
            </a>
            <a
              href="/audit"
              className="rounded-lg border border-rule bg-panel/80 px-5 py-2.5 text-[14.5px] font-medium text-ink backdrop-blur transition hover:border-steel-dim"
            >
              Open the audit trail
            </a>
          </div>

          <div className="mt-10 grid grid-cols-1 divide-y divide-rule border-t border-rule sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {STATS.map((s) => (
              <div key={s.body} className="py-4 sm:pt-4 sm:pr-4 sm:pb-0 sm:pl-4 sm:first:pl-0">
                <p className={`display text-[30px] leading-none tnum ${s.tone}`}>
                  {s.n}
                  {s.unit && <span className="ml-1 text-[17px] text-ink-2">{s.unit}</span>}
                </p>
                <p className="mt-2 text-[12.5px] leading-snug text-ink-2">{s.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* The product, inset in a lit frame the way a screenshot sits on a desk — the molten field
            runs behind and around it, so the window reads as sitting in the page, not pasted on. */}
        <div className="rounded-[20px] border border-rule bg-gradient-to-b from-steel-dim/20 to-transparent p-2.5 sm:p-4">
          <div className="group relative overflow-hidden rounded-xl border border-rule bg-panel shadow-[0_40px_120px_-30px_rgba(0,0,0,1)]">
            <div className="flex items-center gap-2 border-b border-rule bg-panel-2 px-4 py-3">
              <span aria-hidden className="h-[10px] w-[10px] rounded-full bg-[#ff5f57]" />
              <span aria-hidden className="h-[10px] w-[10px] rounded-full bg-[#febc2e]" />
              <span aria-hidden className="h-[10px] w-[10px] rounded-full bg-[#28c840]" />
              <span className="mx-auto flex items-center gap-2 rounded-md bg-ground/70 px-3 py-1 font-mono text-[11px] text-ink-3">
                <span aria-hidden>🔒</span>
                klaxon-ethonline.vercel.app/audit
              </span>
            </div>
            <iframe
              src="/embed/audit"
              title="The live KLAXON audit trail, read from Hedera"
              loading="lazy"
              tabIndex={-1}
              className="pointer-events-none block h-[420px] w-full border-0 bg-ground lg:h-[520px] xl:h-[560px] 2xl:h-[640px]"
            />
            {/* The click target is a sibling laid over the frame rather than a link wrapped around
                it, because an <a> may not contain an <iframe>. */}
            <a
              href="/audit"
              aria-label="Open the live KLAXON audit trail"
              className="absolute inset-0 flex items-end justify-center pb-6"
            >
              <span className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-ground via-ground/85 to-transparent opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100" />
              <span className="relative rounded-full bg-ink px-5 py-2 text-[13.5px] font-semibold text-ground opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                Check the hashes yourself
              </span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
