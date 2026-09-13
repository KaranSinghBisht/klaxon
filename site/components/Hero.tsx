import Image from "next/image";
import { CHAIN, REFUSED, RELEASED, STOLEN, short } from "@/lib/facts";
import { Veil } from "./Veil";

/** Schematic hairlines drifting behind the type — the drawing under the machined part. */
function Hairlines() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 1440 760"
      preserveAspectRatio="xMidYMid slice"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <path className="hairline" d="M-40 210C220 120 360 330 620 250s420-260 900-120" />
      <path className="hairline" d="M-40 470C260 400 420 600 700 520s520-200 820-60" />
      <circle className="hairline" cx="1180" cy="180" r="58" />
      <circle className="hairline" cx="1256" cy="206" r="22" />
      <path className="hairline" d="M120 640c120-60 180 40 300-10" />
    </svg>
  );
}

export function Hero() {
  return (
    <section className="veil relative overflow-hidden border-b border-rule">
      <div className="veil-lines" aria-hidden />
      <Veil />
      <Hairlines />
            {/* Both renders carry real alpha, so they composite as-is. The ribbon sits behind the
          headline and is allowed to run off both edges; nothing in it needs to be read. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-[2%] z-[2] flex justify-center">
        <Image
          src="/ribbon.png"
          alt=""
          width={1642}
          height={958}
          priority
          className="w-[1500px] max-w-none opacity-[0.42] select-none"
        />
      </div>

      <div className="veil-content mx-auto grid max-w-[1180px] grid-cols-1 gap-10 px-6 pt-20 pb-14 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-10 lg:pt-24">
        {/* The claim, as two states of one sentence: what they took, and what they got. */}
        <h1 className="display relative text-[clamp(2.9rem,8.2vw,6.4rem)] font-extrabold uppercase">
          <span className="ghost block">Take all of it</span>
          <span className="chrome relative z-10 -mt-[0.12em] block">You still</span>
          <span className="chrome relative z-10 -mt-[0.06em] block">can&apos;t use it</span>
        </h1>

        <div className="relative flex justify-center lg:justify-end">
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-1/2 h-[380px] w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-[90px]"
            style={{ background: "radial-gradient(circle, rgba(255,59,48,0.45) 0%, transparent 68%)" }}
          />
          <Image
            src="/horn.png"
            alt="An industrial alarm horn in gunmetal and worn brass"
            width={1254}
            height={1254}
            priority
            className="relative w-[300px] drop-shadow-[0_40px_80px_rgba(0,0,0,0.9)] sm:w-[380px] lg:w-[440px]"
          />
        </div>
      </div>

      <div className="veil-content mx-auto -mt-8 max-w-[1180px] px-6 pb-4">
        <div className="max-w-[52ch]">
          <p className="max-w-[46ch] text-[16.5px] leading-relaxed text-ink-2">
            The encrypted share out of the repository. The Ledger credential off the runner. The
            payment key. A copy of the release step itself. None of it opens the secret anywhere but
            the one job the owner authorised — and finding that out leaves a receipt nobody can
            delete.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <a
              href="#evidence"
              className="rounded-lg bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-ground transition hover:brightness-95"
            >
              See it actually happen
            </a>
            <a
              href="/audit"
              className="rounded-lg border border-rule bg-panel px-5 py-2.5 text-[14.5px] font-medium text-ink transition hover:border-steel-dim"
            >
              Open the audit trail
            </a>
          </div>

          <p className="mt-6 flex items-center gap-2 font-mono text-[11px] text-ink-3">
            <span aria-hidden className="relative flex h-2 w-2">
              <span className="alarm absolute inline-flex h-full w-full rounded-full bg-signal" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-signal" />
            </span>
            witness live · topic {CHAIN.topic} · settled through {CHAIN.facilitator}
          </p>
        </div>
      </div>


      {/* Three numbers from the runs themselves, sitting where they cannot collide with anything. */}
      <div className="veil-content mx-auto max-w-[1180px] px-6">
        <div className="grid grid-cols-1 divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-panel/70 backdrop-blur sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="p-6">
            <p className="display text-[40px] leading-none font-extrabold text-signal tnum">
              {STOLEN.varsRead}
            </p>
            <p className="mt-2.5 text-[13.5px] leading-snug text-ink-2">
              environment variables a compromised dependency read in the unprotected pipeline. One
              was the deploy key.
            </p>
          </div>
          <div className="p-6">
            <p className="display text-[40px] leading-none font-extrabold text-ink tnum">
              {CHAIN.priceHbar}
              <span className="ml-1.5 text-[22px] text-ink-2">ℏ</span>
            </p>
            <p className="mt-2.5 text-[13.5px] leading-snug text-ink-2">
              settled on Hedera by an attacker holding every credential — and refused at check{" "}
              {REFUSED.check}, on the record.
            </p>
          </div>
          <div className="p-6">
            <p className="display text-[40px] leading-none font-extrabold text-good tnum">0</p>
            <p className="mt-2.5 text-[13.5px] leading-snug text-ink-2">
              secrets that same worm got out of the protected pipeline, across every run.
            </p>
          </div>
        </div>
      </div>

      {/* The product, running, in browser chrome. */}
      <div className="veil-content mx-auto max-w-[1100px] px-6 pt-16 pb-20">
        <a
          href="/audit"
          aria-label="Open the live KLAXON audit trail"
          className="group relative block overflow-hidden rounded-xl border border-rule bg-panel shadow-[0_60px_130px_-45px_rgba(0,0,0,1)]"
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
            className="pointer-events-none h-[460px] w-full border-0 bg-ground"
          />
          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-ground via-ground/80 to-transparent pt-16 pb-6 opacity-0 transition group-hover:opacity-100">
            <span className="rounded-full bg-ink px-5 py-2 text-[13.5px] font-semibold text-ground">
              Check the hashes yourself
            </span>
          </span>
        </a>
        <p className="mt-4 text-center text-[13px] text-ink-3">
          Reads Hedera in your browser and re-checks every payment memo against the commitment it
          claims to be. It never calls KLAXON.
        </p>
      </div>
    </section>
  );
}
