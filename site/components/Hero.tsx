import { CHAIN, REFUSED, STOLEN } from "@/lib/facts";
import { Veil } from "./Veil";

export function Hero() {
  return (
    <section className="veil relative overflow-hidden border-b border-rule">
      <Veil />

      <div className="veil-content mx-auto max-w-[1100px] px-6 pt-24 pb-16 text-center lg:pt-32">
        <h1 className="display mx-auto max-w-[16ch] text-[clamp(2.5rem,6.2vw,4.9rem)]">
          Take all of it. You still can&apos;t use it.
        </h1>

        <p className="mx-auto mt-7 max-w-[64ch] text-[17px] leading-relaxed text-ink-2">
          The encrypted share out of the repository. The Ledger credential off the runner. The
          payment key. A copy of the release step itself. None of it opens the secret anywhere but
          the one job the owner authorised — and finding that out leaves a receipt nobody can delete.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
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

        <p className="mt-6 inline-flex items-center gap-2 font-mono text-[11px] text-ink-3">
          <span aria-hidden className="relative flex h-2 w-2">
            <span className="alarm absolute inline-flex h-full w-full rounded-full bg-signal" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-signal" />
          </span>
          witness live · topic {CHAIN.topic} · settled through {CHAIN.facilitator}
        </p>
      </div>

      {/* The product, inset in a lit frame the way a screenshot sits on a desk — the molten field
          runs behind and around it, so the window reads as sitting in the page, not pasted onto it. */}
      <div className="veil-content mx-auto max-w-[1180px] px-6">
        <div className="rounded-t-[20px] border border-b-0 border-rule bg-gradient-to-b from-steel-dim/20 to-transparent px-3 pt-3 sm:px-8 sm:pt-8">
          <a
            href="/audit"
            aria-label="Open the live KLAXON audit trail"
            className="group relative block overflow-hidden rounded-t-xl border border-b-0 border-rule bg-panel shadow-[0_-10px_120px_-30px_rgba(0,0,0,1)]"
          >
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
              className="pointer-events-none h-[440px] w-full border-0 bg-ground"
            />
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-ground via-ground/85 to-transparent pt-16 pb-6 opacity-0 transition group-hover:opacity-100">
              <span className="rounded-full bg-ink px-5 py-2 text-[13.5px] font-semibold text-ground">
                Check the hashes yourself
              </span>
            </span>
          </a>
        </div>
      </div>

      {/* Three numbers from the runs themselves. */}
      <div className="veil-content mx-auto max-w-[1180px] px-6 pt-14 pb-20">
        <div className="grid grid-cols-1 divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-panel/60 backdrop-blur sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="p-6">
            <p className="display text-[40px] leading-none text-signal tnum">{STOLEN.varsRead}</p>
            <p className="mt-2.5 text-[13.5px] leading-snug text-ink-2">
              environment variables a compromised dependency read in the unprotected pipeline. One
              was the deploy key.
            </p>
          </div>
          <div className="p-6">
            <p className="display text-[40px] leading-none text-ink tnum">
              {CHAIN.priceHbar}
              <span className="ml-1.5 text-[22px] text-ink-2">ℏ</span>
            </p>
            <p className="mt-2.5 text-[13.5px] leading-snug text-ink-2">
              settled on Hedera by an attacker holding every credential — and refused at check{" "}
              {REFUSED.check}, on the record.
            </p>
          </div>
          <div className="p-6">
            <p className="display text-[40px] leading-none text-good tnum">0</p>
            <p className="mt-2.5 text-[13.5px] leading-snug text-ink-2">
              secrets that same worm got out of the protected pipeline, across every run.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
