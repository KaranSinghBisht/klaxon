import { AuditTrail } from "./AuditTrail";
import { proveAll, readTopic } from "@/lib/audit";
import { Footer, Nav } from "@/components/Chrome";
import { CHAIN, WITNESS } from "@/lib/facts";

export const metadata = {
  title: "KLAXON — the audit trail",
  description:
    "Every release and every refusal, read from Hedera in your own browser and re-checked against the payment that paid for it.",
};

export const revalidate = 60;

export default async function AuditPage() {
  const initial = await readTopic().catch(() => undefined);
  const proofs = initial ? await proveAll(initial).catch(() => undefined) : undefined;
  return (
    <main className="min-h-screen">
      <Nav />
      <section className="mx-auto max-w-[1040px] px-6 pt-14 pb-20">
        <p className="gutter">the audit trail</p>
        <h1 className="display mt-4 max-w-[20ch] text-[clamp(1.9rem,4.4vw,3rem)] font-bold">
          Don&apos;t take our word for any of it.
        </h1>
        <p className="mt-5 max-w-[64ch] text-[16px] leading-relaxed text-ink-2">
          This page reads topic <span className="font-mono text-ink">{CHAIN.topic}</span> from
          Hedera&apos;s public mirror node, reassembles the chunked records, and for every release
          and refusal checks in your browser that the payment memo is the commitment the runner
          signed.
        </p>
        <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-ink-3">
          It never calls the witness. If that service went down or started lying, this page would
          keep working and show the gap.
        </p>

        <AuditTrail initial={initial} proofs={proofs} />

        <p className="mt-10 font-mono text-[11px] leading-relaxed text-ink-3">
          witness account {CHAIN.witnessAccount} · registry {CHAIN.registry} on sepolia ·{" "}
          <a className="underline underline-offset-2" href={`${WITNESS}/.well-known/klaxon.json`}>
            service manifest
          </a>
        </p>
      </section>
      <Footer />
    </main>
  );
}
