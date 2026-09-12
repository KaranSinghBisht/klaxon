"use client";

import { useCallback, useEffect, useState } from "react";
import { CHAIN, hashscanTx, runUrl, short } from "@/lib/facts";

const MIRROR = "https://testnet.mirrornode.hedera.com";

type Claims = {
  secret?: string;
  environment?: string;
  gen?: string;
  run_id?: string;
  run_attempt?: string;
};

type Record_ = {
  type?: string;
  ts?: string;
  h?: string;
  pay_tx?: string;
  C?: Claims;
  check?: number;
  class?: string;
  reason?: string;
  epoch?: string;
  sepolia_tx?: string;
};

type Entry = { body: Record_ | null; seqs: number[]; at: string };
type Proof = { state: "ok" | "bad" | "unknown"; detail: string };

/** HCS caps a message near 1 KB, so a record carrying a whole OIDC token arrives in pieces. */
function reassemble(messages: any[]): Entry[] {
  const groups = new Map<string, { n: number; m: any }[]>();
  for (const m of messages) {
    const ci = m.chunk_info ?? {};
    const key = ci.initial_transaction_id
      ? `${ci.initial_transaction_id.account_id}@${ci.initial_transaction_id.transaction_valid_start}`
      : `solo-${m.sequence_number}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ n: ci.number ?? 1, m });
  }
  const out: Entry[] = [];
  for (const parts of groups.values()) {
    parts.sort((a, b) => a.n - b.n);
    const text = parts.map((p) => atob(p.m.message)).join("");
    const last = parts[parts.length - 1].m;
    let body: Record_ | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    out.push({ body, seqs: parts.map((p) => p.m.sequence_number), at: last.consensus_timestamp });
  }
  return out.sort((a, b) => Number(b.at) - Number(a.at));
}

const dashed = (id: string) => {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(id ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

async function proveMemo(payTx: string | undefined, h: string | undefined): Promise<Proof> {
  const id = payTx ? dashed(payTx) : null;
  if (!id || !h) return { state: "unknown", detail: "no payment named in the record" };
  try {
    const res = await fetch(`${MIRROR}/api/v1/transactions/${id}`);
    if (!res.ok) return { state: "unknown", detail: `mirror node answered ${res.status}` };
    const tx = (await res.json()).transactions?.[0];
    if (!tx) return { state: "unknown", detail: "not indexed yet" };
    const memo = tx.memo_base64 ? atob(tx.memo_base64) : "";
    const credit = (tx.transfers ?? []).find(
      (t: any) => t.account === CHAIN.witnessAccount && t.amount > 0,
    );
    return memo === h
      ? {
          state: "ok",
          detail: `memo is the commitment · witness credited ${credit ? credit.amount.toLocaleString() : "?"} tinybar`,
        }
      : { state: "bad", detail: `memo is ${short(memo, 10, 6) || "empty"}, not this commitment` };
  } catch {
    return { state: "unknown", detail: "could not reach the mirror node" };
  }
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-rule-soft py-2 sm:flex-row sm:gap-4">
      <span className="w-[150px] shrink-0 font-mono text-[10.5px] tracking-[0.08em] text-ink-3 uppercase">
        {k}
      </span>
      <span className="font-mono text-[12px] break-all text-ink">{children}</span>
    </div>
  );
}

const link = "text-steel underline decoration-steel-dim/50 underline-offset-2 hover:brightness-125";

function Card({ entry }: { entry: Entry }) {
  const b = entry.body;
  const [proof, setProof] = useState<Proof | null>(null);

  useEffect(() => {
    if (!b || b.type === "unrevoke") return;
    let live = true;
    proveMemo(b.pay_tx, b.h).then((p) => live && setProof(p));
    return () => {
      live = false;
    };
  }, [b]);

  if (!b) {
    return (
      <article className="rounded-xl border border-rule bg-panel p-5">
        <p className="gutter">unreadable · sequence {entry.seqs.join(", ")}</p>
      </article>
    );
  }

  const kind = b.type ?? "unknown";
  const C = b.C ?? {};
  const accent =
    kind === "released"
      ? "border-l-good"
      : kind === "refused"
        ? "border-l-signal"
        : "border-l-steel-dim";
  const badge =
    kind === "released"
      ? "border-good-line bg-good-soft text-good"
      : kind === "refused"
        ? "border-signal-line bg-signal-soft text-signal"
        : "border-rule bg-panel-2 text-steel";

  const when = new Date(b.ts ?? Number(entry.at) * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  return (
    <article className={`overflow-hidden rounded-xl border border-rule border-l-2 ${accent} bg-panel`}>
      <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
        <span className={`gutter border px-2 py-0.5 ${badge}`}>{kind}</span>
        <h3 className="text-[15.5px] font-semibold">
          {kind === "unrevoke"
            ? `project recovered at epoch ${b.epoch}`
            : kind === "released"
              ? `${C.secret} released to ${C.environment}`
              : `${C.secret} refused`}
        </h3>
        <span className="ml-auto font-mono text-[11px] text-ink-3">{when} UTC</span>
      </div>

      {kind === "refused" && (
        <p className="px-5 pt-2 text-[13.5px] text-signal">
          check {b.check} ({b.class}) — {b.reason}
        </p>
      )}

      <div className="px-5 pt-3 pb-4">
        {kind === "unrevoke" ? (
          <>
            <Row k="sepolia tx">
              <a className={link} href={`https://sepolia.etherscan.io/tx/${b.sepolia_tx}`}>
                {short(b.sepolia_tx ?? "", 18, 8)}
              </a>
            </Row>
            <Row k="epoch">{b.epoch}</Row>
          </>
        ) : (
          <>
            {C.run_id && (
              <Row k="github run">
                <a className={link} href={runUrl(C.run_id)}>
                  {C.run_id}
                </a>{" "}
                · attempt {C.run_attempt ?? "1"}
              </Row>
            )}
            <Row k="environment">{C.environment || "(none declared)"}</Row>
            <Row k="commitment">{short(b.h ?? "", 24, 10)}</Row>
            {b.pay_tx && (
              <Row k="payment">
                <a className={link} href={hashscanTx(b.pay_tx)}>
                  {b.pay_tx}
                </a>
              </Row>
            )}
            <Row k="memo binding">
              {proof ? (
                <span
                  className={
                    proof.state === "ok"
                      ? "text-good"
                      : proof.state === "bad"
                        ? "text-signal"
                        : "text-ink-3"
                  }
                >
                  {proof.state === "ok" ? "✓" : proof.state === "bad" ? "✗" : "•"} {proof.detail}
                </span>
              ) : (
                <span className="text-ink-3">checking against Hedera…</span>
              )}
            </Row>
            <Row k="hcs sequence">{entry.seqs.join(", ")}</Row>
          </>
        )}
      </div>
    </article>
  );
}

export function AuditTrail() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setEntries(null);
    setError(null);
    try {
      const res = await fetch(
        `${MIRROR}/api/v1/topics/${CHAIN.topic}/messages?limit=100&order=asc`,
      );
      setEntries(reassemble((await res.json()).messages ?? []));
    } catch {
      setError("Could not reach the Hedera mirror node from this browser.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const released = entries?.filter((e) => e.body?.type === "released").length ?? 0;
  const refused = entries?.filter((e) => e.body?.type === "refused").length ?? 0;

  return (
    <>
      <div className="mt-8 flex flex-wrap items-center gap-2.5">
        <span className="gutter border border-rule bg-panel px-2.5 py-1">
          {entries ? `${entries.length} records` : "reading…"}
        </span>
        {released > 0 && (
          <span className="gutter border border-good-line bg-good-soft px-2.5 py-1 text-good">
            {released} released
          </span>
        )}
        {refused > 0 && (
          <span className="gutter border border-signal-line bg-signal-soft px-2.5 py-1 text-signal">
            {refused} refused
          </span>
        )}
        <button
          onClick={load}
          className="ml-auto rounded-md border border-rule bg-panel px-3 py-1.5 text-[13px] hover:border-ink-3"
        >
          Refresh
        </button>
      </div>

      <div className="mt-5 space-y-3">
        {error && <p className="font-mono text-[13px] text-signal">{error}</p>}
        {!entries && !error && (
          <p className="font-mono text-[13px] text-ink-3">Reading consensus topic {CHAIN.topic}…</p>
        )}
        {entries?.map((e) => <Card key={e.seqs.join("-")} entry={e} />)}
      </div>
    </>
  );
}
