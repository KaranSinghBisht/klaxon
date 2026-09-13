import { CHAIN, COST, DEMO_REPO, REPO, WITNESS } from "@/lib/facts";
import { Mark } from "./Mark";

export function Nav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-rule bg-ground/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1040px] items-center gap-5 px-6 py-3.5">
        <a href="#top" className="flex items-center gap-2.5">
          <Mark className="h-[18px] w-[18px] text-ink" />
          <span className="text-[15px] font-bold tracking-[0.14em]">KLAXON</span>
        </a>
        <div className="ml-auto flex items-center gap-5 text-[13.5px] text-ink-2">
          <a href="#problem" className="hidden hover:text-ink sm:inline">
            Problem
          </a>
          <a href="#protocol" className="hidden hover:text-ink sm:inline">
            Protocol
          </a>
          <a href="#how" className="hidden hover:text-ink sm:inline">
            How
          </a>
          <a href="#evidence" className="hidden hover:text-ink sm:inline">
            Evidence
          </a>
          <a href="/audit" className="hover:text-ink">
            Audit
          </a>
          <a
            href={REPO}
            className="rounded-md border border-rule bg-panel px-3 py-1.5 font-medium text-ink hover:border-ink-3"
          >
            GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}

const STACK = [
  {
    who: "Ledger",
    what: "Key Ring, on a host with no USB port",
    body: "wallet-cli ring enrols the trustchain on a physical Nano S Plus. A hosted GitHub runner then restores it headlessly — no device attached — and decrypts share A. The device alone can move policy or lift a revocation.",
  },
  {
    who: "Hedera",
    what: "x402, settled through Blocky402",
    body: `The witness is a live x402-gated service. Every release is a real HBAR transfer whose memo is the commitment hash, and every decision — including every refusal — is published to consensus topic ${CHAIN.topic}.`,
  },
];

export function Stack() {
  return (
    <section className="border-b border-rule bg-ground-2">
      <div className="mx-auto max-w-[1040px] px-6 py-16">
        <p className="gutter">what it is built on, and why</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {STACK.map((s) => (
            <div key={s.who} className="rounded-xl border border-rule bg-panel p-6">
              <p className="text-[19px] font-bold">{s.who}</p>
              <p className="mt-1 text-[13.5px] font-medium text-steel">{s.what}</p>
              <p className="mt-3 text-[14px] leading-relaxed text-ink-2">{s.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-xl border border-rule bg-panel p-6">
          <p className="gutter">the part nobody puts on a landing page</p>
          <p className="mt-2.5 max-w-[70ch] text-[14.5px] leading-relaxed text-ink-2">
            Publishing one audit record costs the witness{" "}
            <span className="font-mono text-ink tnum">{COST.total.toLocaleString("en-US")}</span> tinybar in
            consensus fees, against{" "}
            <span className="font-mono text-ink tnum">{COST.revenue.toLocaleString("en-US")}</span> of
            revenue — about a <span className="text-ink">{COST.ratio}× loss per release</span>,
            measured off the mirror node. The record chunks across three messages because it carries
            the runner&apos;s whole OIDC token, so a verifier needs nobody&apos;s permission to check
            it. The {CHAIN.priceHbar} ℏ was never a fee that recovers cost. It is the commitment.
          </p>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="bg-ground">
      <div className="mx-auto max-w-[1040px] px-6 py-14">
        <p className="display text-[clamp(1.6rem,3.4vw,2.4rem)] font-bold">
          Stolen, but never quietly.
        </p>
        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-ink-2">
          <a href={REPO} className="hover:text-ink">
            Source
          </a>
          <a href={DEMO_REPO} className="hover:text-ink">
            The demo repository
          </a>
          <a href="/audit" className="hover:text-ink">
            Live audit trail
          </a>
          <a href={`${WITNESS}/.well-known/klaxon.json`} className="hover:text-ink">
            Service manifest
          </a>
        </div>
        <p className="mt-8 font-mono text-[11px] leading-relaxed text-ink-3">
          registry {CHAIN.registry} on sepolia · topic {CHAIN.topic} on hedera testnet
          <br />
          built for ETHOnline 2026 · Apache-2.0
        </p>
      </div>
    </footer>
  );
}
