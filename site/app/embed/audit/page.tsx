import { AuditTrail } from "@/app/audit/AuditTrail";
import { proveAll, readTopic } from "@/lib/audit";
import { CHAIN } from "@/lib/facts";

/** The same audit trail with no navigation, for the framed preview on the landing page. */
export const metadata = { title: "KLAXON audit", robots: { index: false } };

export const revalidate = 60;

export default async function EmbeddedAudit() {
  const initial = await readTopic().catch(() => undefined);
  const proofs = initial ? await proveAll(initial).catch(() => undefined) : undefined;
  return (
    <main className="px-7 pt-7 pb-10">
      <p className="gutter">live · consensus topic {CHAIN.topic}</p>
      <h2 className="display mt-2 text-[24px] font-bold">
        Every release, and every refusal.
      </h2>
      <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-ink-2">
        Read from Hedera in your browser, then checked against the payment that paid for it.
      </p>
      <AuditTrail initial={initial} proofs={proofs} />
    </main>
  );
}
