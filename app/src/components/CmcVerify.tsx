"use client";
import { useState } from "react";
import { keccak256, toBytes, type Hex } from "viem";
import { short } from "@/lib/format";
import { bytesHash, responseHashOf } from "@/lib/verify";
import { Card } from "./ui";

// Recompute an on-chain CMC snapshot's responseHash in the browser from the raw CMC bodies the keeper logged.
export function VerifyPanel({ expected, snapshotId, className = "lg:col-span-2", title = "Verify CMC data in your browser" }: { expected?: Hex; snapshotId?: bigint; className?: string; title?: string }) {
  const [text, setText] = useState("");
  const [lines, setLines] = useState<{ ok: boolean | null; text: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const bodyHash = text ? keccak256(toBytes(text)) : undefined;

  // Recompute the on-chain responseHash from the raw CMC bodies: keccak256(bodyHash_1 ‖ … ) in data.components order.
  const verifySnapshot = async () => {
    if (!snapshotId || !expected) return;
    setBusy(true);
    const out: { ok: boolean | null; text: string }[] = [];
    try {
      const r = await fetch(`/api/risk/snapshot/${snapshotId}`);
      if (!r.ok) throw new Error(`snapshot #${snapshotId}: HTTP ${r.status}`);
      const j = (await r.json()) as { logEntry?: { data?: { components?: { kind: string; bodyHash: Hex }[] } } };
      const comps = j.logEntry?.data?.components ?? [];
      if (!comps.length) throw new Error("log entry has no components");
      const hashes: Hex[] = [];
      for (const c of comps) {
        const raw = await fetch(`/api/risk/raw/${c.bodyHash}`);
        if (!raw.ok) {
          out.push({ ok: null, text: `${c.kind}: raw body not served (HTTP ${raw.status}); using logged bodyHash` });
          hashes.push(c.bodyHash);
          continue;
        }
        const h = bytesHash(await raw.arrayBuffer());
        out.push({ ok: h.toLowerCase() === c.bodyHash.toLowerCase(), text: `${c.kind}: keccak256(body) = ${short(h, 8)}` });
        hashes.push(h);
      }
      const rh = responseHashOf(hashes);
      out.push({ ok: rh.toLowerCase() === expected.toLowerCase(), text: `responseHash = ${short(rh, 10)} ${rh.toLowerCase() === expected.toLowerCase() ? "matches" : "does not match"} the RiskOracle snapshot #${snapshotId}` });
    } catch (e) {
      out.push({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
    setLines(out);
    setBusy(false);
  };

  return (
    <Card title={title} className={className}>
      <p className="text-xs text-muted">
        The keeper posts responseHash = keccak256(bodyHash₁ ‖ bodyHash₂ ‖ …) over the raw CMC bodies it used. This re-downloads each body from the log store and recomputes every hash locally.
      </p>
      <button className="btn btn-sm mt-2" disabled={!snapshotId || snapshotId === 0n || busy} onClick={verifySnapshot}>
        {busy ? "Verifying…" : `Verify snapshot #${snapshotId?.toString() ?? "–"}`}
      </button>
      {lines && (
        <ul className="mt-2 space-y-0.5 break-all font-mono text-xs">
          {lines.map((l, i) => <li key={i} className={l.ok === true ? "text-good" : l.ok === false ? "text-bad" : "text-muted"}>{l.ok === true ? "✓" : l.ok === false ? "✕" : "·"} {l.text}</li>)}
        </ul>
      )}
      <textarea className="input mt-3 h-24 resize-y" placeholder="Or paste one raw CMC body to get its bodyHash" value={text} onChange={(e) => setText(e.target.value)} />
      {bodyHash && <div className="mt-1 break-all font-mono text-xs text-muted">bodyHash = {bodyHash}</div>}
    </Card>
  );
}
