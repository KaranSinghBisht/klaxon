import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHAIN, REFUSED, RELEASED, STOLEN, short } from "@/lib/facts";

/** Use a render if one has been dropped into public/. The page is composed to work without it. */
function asset(...names: string[]): string | null {
  for (const n of names) {
    if (existsSync(join(process.cwd(), "public", n))) return `/${n}`;
  }
  return null;
}

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

function Artefacts() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 hidden 2xl:block">
      <div
        className="chip drift absolute top-[120px] left-[max(1rem,calc(50%-700px))] w-[228px] p-4"
        style={{ "--tilt": "-4deg" } as React.CSSProperties}
      >
        <p className="gutter text-signal">exfiltrated</p>
        <p className="mt-2 font-mono text-[26px] leading-none font-semibold text-signal tnum">
          {STOLEN.varsRead}
        </p>
        <p className="mt-1 text-[12px] leading-snug text-ink-2">
          variables read during <span className="font-mono">npm install</span>
        </p>
      </div>

      <div
        className="chip drift absolute bottom-[150px] left-[max(0.5rem,calc(50%-716px))] w-[224px] p-4"
        style={{ "--tilt": "3deg", animationDelay: "-3s" } as React.CSSProperties}
      >
        <p className="gutter">memo = commitment</p>
        <p className="mt-2 font-mono text-[10.5px] leading-relaxed break-all text-ink-2">
          {short(RELEASED.commitment, 20, 6)}
        </p>
        <p className="mt-1.5 font-mono text-[10px] text-good">✓ matches the transfer</p>
      </div>

      <div
        className="chip drift absolute top-[128px] right-[max(1rem,calc(50%-700px))] w-[232px] p-4"
        style={{ "--tilt": "4deg", animationDelay: "-5s" } as React.CSSProperties}
      >
        <p className="gutter text-signal">refused · check {REFUSED.check}</p>
        <p className="mt-2 text-[12.5px] leading-snug text-ink">{REFUSED.reason}</p>
        <p className="mt-2 font-mono text-[10px] text-ink-3">paid {CHAIN.priceHbar} ℏ anyway</p>
      </div>
    </div>
  );
}

export function Hero() {
  const ribbon = asset("ribbon.png", "ribbon.webp", "ribbon.jpg");

  return (
    <section className="relative overflow-hidden border-b border-rule bg-ground">
      <Hairlines />
      {ribbon ? (
        <img
          src={ribbon}
          alt=""
          aria-hidden
          className="plate pointer-events-none absolute top-[-6%] left-1/2 w-[1500px] max-w-none -translate-x-1/2 opacity-90 select-none"
        />
      ) : (
        <div
          aria-hidden
          className="pointer-events-none absolute top-[-180px] left-1/2 h-[620px] w-[1100px] -translate-x-1/2 rounded-full opacity-[0.07] blur-[120px]"
          style={{ background: "radial-gradient(circle, #c3c9d2 0%, transparent 68%)" }}
        />
      )}
      <Artefacts />

      <div className="relative mx-auto grid max-w-[1180px] grid-cols-1 gap-10 px-6 pt-20 pb-24 lg:grid-cols-[1.35fr_1fr] lg:items-end lg:gap-14 lg:pt-28">
        {/* The claim, as two states of one sentence: what they took, and what they got. */}
        <h1 className="display relative text-[clamp(2.9rem,8.2vw,6.4rem)] font-extrabold uppercase">
          <span className="ghost block">Take all of it</span>
          <span className="chrome relative z-10 -mt-[0.12em] block">You still</span>
          <span className="chrome relative z-10 -mt-[0.06em] block">can&apos;t use it</span>
        </h1>

        <div className="lg:pb-4">
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

      {/* The product, running, in browser chrome. */}
      <div className="relative mx-auto max-w-[1100px] px-6 pb-20">
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
