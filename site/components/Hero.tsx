import { CHAIN, REFUSED, RELEASED, STOLEN, WITNESS, short } from "@/lib/facts";

/**
 * Floating artefacts, every one of them real: the commitment that was served, the commitment that
 * was refused, the price the attacker paid, and what the worm actually walked away with. Nothing
 * here is a mock-up of a number — each one is on a public ledger right now.
 */
function Artefacts() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 hidden xl:block">
      <div
        className="chip drift absolute top-[70px] left-[max(1rem,calc(50%-640px))] w-[250px] p-4"
        style={{ "--tilt": "-4deg" } as React.CSSProperties}
      >
        <p className="gutter text-signal">exfiltrated · ordinary pipeline</p>
        <p className="mt-2 font-mono text-[26px] leading-none font-semibold text-signal tnum">
          {STOLEN.varsRead}
        </p>
        <p className="mt-1 text-[12.5px] leading-snug text-ink-2">
          environment variables read during <span className="font-mono">npm install</span>. One of
          them was the deploy key.
        </p>
      </div>

      <div
        className="chip drift absolute top-[318px] left-[max(0.25rem,calc(50%-672px))] w-[236px] p-4"
        style={{ "--tilt": "3deg", animationDelay: "-2.4s" } as React.CSSProperties}
      >
        <p className="gutter">memo = commitment</p>
        <p className="mt-2 font-mono text-[11px] leading-relaxed break-all text-ink">
          {short(RELEASED.commitment, 22, 8)}
        </p>
        <p className="mt-1.5 font-mono text-[10.5px] text-good">
          ✓ matches the Hedera transfer
        </p>
      </div>

      <div
        className="chip drift absolute top-[76px] right-[max(1rem,calc(50%-640px))] w-[244px] p-4"
        style={{ "--tilt": "4deg", animationDelay: "-4.1s" } as React.CSSProperties}
      >
        <p className="gutter text-signal">refused · check {REFUSED.check}</p>
        <p className="mt-2 text-[13px] leading-snug text-ink">{REFUSED.reason}</p>
        <p className="mt-2 font-mono text-[10.5px] text-ink-3">
          paid {CHAIN.priceHbar} ℏ · hcs #{REFUSED.hcs}
        </p>
      </div>

      <div
        className="chip drift absolute top-[330px] right-[max(0.5rem,calc(50%-662px))] w-[210px] p-4 text-center"
        style={{ "--tilt": "-3deg", animationDelay: "-6s" } as React.CSSProperties}
      >
        <p className="font-mono text-[26px] leading-none font-semibold text-brass tnum">
          {CHAIN.priceHbar}
          <span className="ml-1 text-[15px]">ℏ</span>
        </p>
        <p className="gutter mt-2">what it costs to be refused</p>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="grain relative overflow-hidden border-b border-rule">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[560px] w-[860px] -translate-x-1/2 rounded-full opacity-[0.16] blur-[110px]"
        style={{ background: "radial-gradient(circle, #d9a441 0%, transparent 66%)" }}
      />
      <Artefacts />

      <div className="relative mx-auto max-w-[980px] px-6 pt-24 pb-16 text-center sm:pt-28">
        <p className="gutter">ETHOnline 2026 · Ledger × Hedera</p>

        <h1 className="display mt-6 text-[clamp(2.6rem,7vw,5.1rem)] font-extrabold">
          Take all of it.
          <br />
          You still can&apos;t use it.
        </h1>

        <p className="mx-auto mt-7 max-w-[660px] text-[17px] leading-relaxed text-ink-2">
          Take the encrypted share out of the repository. Take the Ledger credential off the runner,
          the payment key, even a copy of the release step. None of it opens the secret anywhere
          except the one job the owner authorised — and finding that out leaves a receipt nobody can
          delete.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <a
            href="#evidence"
            className="rounded-lg bg-brass px-5 py-2.5 text-[14.5px] font-semibold text-[#17130a] transition hover:brightness-110"
          >
            See it actually happen
          </a>
          <a
            href="/audit"
            className="rounded-lg border border-rule bg-panel px-5 py-2.5 text-[14.5px] font-medium text-ink transition hover:border-ink-3"
          >
            Open the live audit trail
          </a>
        </div>

        <p className="mt-5 font-mono text-[11.5px] text-ink-3">
          witness is live · topic {CHAIN.topic} · settled through {CHAIN.facilitator}
        </p>
      </div>

      {/* The product itself, in browser chrome, reading live Hedera data. Not a screenshot. */}
      <div className="relative mx-auto max-w-[1040px] px-6 pb-20">
        <a
          href="/audit"
          aria-label="Open the live KLAXON audit trail"
          className="group block overflow-hidden rounded-t-xl border border-rule bg-panel shadow-[0_50px_110px_-40px_rgba(0,0,0,0.95)]"
        >
          <div className="flex items-center gap-2 border-b border-rule bg-panel-2 px-4 py-3">
            <span aria-hidden className="h-[10px] w-[10px] rounded-full bg-[#ff5f57]" />
            <span aria-hidden className="h-[10px] w-[10px] rounded-full bg-[#febc2e]" />
            <span aria-hidden className="h-[10px] w-[10px] rounded-full bg-[#28c840]" />
            <span className="mx-auto flex items-center gap-2 rounded-md bg-ground/70 px-3 py-1 font-mono text-[11px] text-ink-3">
              <span aria-hidden>🔒</span>
              klaxon-iota.vercel.app/audit
            </span>
          </div>
          <iframe
            src="/embed/audit"
            title="The live KLAXON audit trail, read from Hedera"
            loading="lazy"
            tabIndex={-1}
            className="pointer-events-none h-[460px] w-full border-0 bg-ground"
          />
          <span className="pointer-events-none absolute inset-x-6 bottom-20 flex justify-center opacity-0 transition group-hover:opacity-100">
            <span className="rounded-full bg-ink px-5 py-2 text-[13.5px] font-semibold text-ground shadow-xl">
              Open it and check the hashes yourself
            </span>
          </span>
        </a>
        <p className="mt-4 text-center text-[13px] text-ink-3">
          That page reads the Hedera mirror node in your browser and re-checks every payment memo
          against the commitment it claims to be. It never calls KLAXON.
        </p>
      </div>
    </section>
  );
}
