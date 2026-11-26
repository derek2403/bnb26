import { concat, decodeEventLog, keccak256, type Hex } from "viem";
import { logAnchorAbi, riskOracleAbi } from "../abi/index.js";
import { loadDeployments } from "../config/deployments.js";
import { chainKindOf, publicClient } from "./chains.js";
import { computeEntryHash, entriesRange, loadRaw, type StoredEntry } from "./hashlog.js";
import { merkleProof, merkleRoot, verifyProof } from "./merkle.js";
import { toFixed } from "./math.js";

/**
 * verify-snapshot <tx>: checks one RiskOracle.post against the published log, end to end.
 *  1. the tx emitted CmcSnapshot(assetId, snapshotId, …, responseHash)
 *  2. log entry #snapshotId is a "snapshot" entry whose bodyHash == responseHash and whose values match the event
 *  3. every component raw body re-hashes to its bodyHash, and keccak256(bodyHash_1 ‖ …) == responseHash
 *  4. the entry's own hash recomputes (prevHash ‖ canonicalJSON(entry))
 *  5. an on-chain LogAnchor range covers the seq and the Merkle proof reaches its root
 * Data comes from Postgres when available, else from a services API base URL (--api).
 */
export interface Source {
  range(from: number, to: number): Promise<StoredEntry[]>;
  raw(hash: string): Promise<Uint8Array | undefined>;
}

export const dbSource: Source = {
  range: (f, t) => entriesRange(f, t),
  raw: async (h) => (await loadRaw(h))?.body,
};

export function apiSource(base: string): Source {
  const b = base.replace(/\/$/, "");
  return {
    range: async (f, t) => {
      const r = await fetch(`${b}/logs/entries?from=${f}&to=${t}`);
      if (!r.ok) throw new Error(`GET /logs/entries ${r.status}`);
      return ((await r.json()) as { entries: StoredEntry[] }).entries;
    },
    raw: async (h) => {
      const r = await fetch(`${b}/logs/raw/${h}`);
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined;
    },
  };
}

interface Check {
  name: string;
  ok: boolean;
  detail?: unknown;
}

export async function verifySnapshot(tx: Hex, chainId: number, src: Source = dbSource) {
  const checks: Check[] = [];
  const kind = chainKindOf(chainId);
  const c = publicClient(kind);
  const d = loadDeployments(chainId);
  const receipt = await c.getTransactionReceipt({ hash: tx });
  let ev: { assetId: Hex; snapshotId: bigint; refPrice: bigint; volBps: bigint; liqUsd: bigint; premiumBps: bigint; cmcTs: bigint; responseHash: Hex } | undefined;
  for (const l of receipt.logs) {
    if (d?.core.riskOracle && l.address.toLowerCase() !== d.core.riskOracle.toLowerCase()) continue;
    try {
      const dec = decodeEventLog({ abi: riskOracleAbi, data: l.data, topics: l.topics });
      if (dec.eventName === "CmcSnapshot") ev = dec.args as unknown as typeof ev;
    } catch {
      /* not ours */
    }
  }
  checks.push({ name: "tx emitted CmcSnapshot", ok: Boolean(ev), detail: ev ? { snapshotId: ev.snapshotId.toString(), responseHash: ev.responseHash } : undefined });
  if (!ev) return { ok: false, checks };
  const seq = Number(ev.snapshotId);
  const [entry] = await src.range(seq, seq);
  checks.push({ name: `log entry #${seq} exists and is a snapshot`, ok: entry?.kind === "snapshot", detail: entry ? { kind: entry.kind, ts: entry.ts } : undefined });
  if (!entry) return { ok: false, checks };
  checks.push({ name: "entry.bodyHash == event.responseHash", ok: entry.bodyHash?.toLowerCase() === ev.responseHash.toLowerCase() });
  const data = (entry.data ?? {}) as { refPrice?: number; volBps?: number; premiumBps?: number; cmcTs?: number; components?: { kind: string; bodyHash: Hex }[] };
  checks.push({
    name: "entry values match the event",
    ok:
      data.refPrice !== undefined &&
      toFixed(Number(data.refPrice).toFixed(8)) === ev.refPrice &&
      BigInt(data.volBps ?? -1) === ev.volBps &&
      BigInt(data.premiumBps ?? 0) === ev.premiumBps &&
      BigInt(data.cmcTs ?? -1) === ev.cmcTs,
    detail: { entry: { refPrice: data.refPrice, volBps: data.volBps, premiumBps: data.premiumBps, cmcTs: data.cmcTs }, event: { refPrice: ev.refPrice.toString(), volBps: ev.volBps.toString(), premiumBps: ev.premiumBps.toString(), cmcTs: ev.cmcTs.toString() } },
  });
  const comps = data.components ?? [];
  const compChecks: { kind: string; bodyHash: string; ok: boolean }[] = [];
  for (const cmp of comps) {
    const body = await src.raw(cmp.bodyHash);
    compChecks.push({ kind: cmp.kind, bodyHash: cmp.bodyHash, ok: Boolean(body) && keccak256(body!).toLowerCase() === cmp.bodyHash.toLowerCase() });
  }
  checks.push({ name: "raw CMC bodies re-hash to their bodyHash", ok: comps.length > 0 && compChecks.every((x) => x.ok), detail: compChecks });
  const recomputed = comps.length ? keccak256(concat(comps.map((x) => x.bodyHash))) : undefined;
  checks.push({ name: "keccak256(bodyHash_1 ‖ …) == responseHash", ok: recomputed?.toLowerCase() === ev.responseHash.toLowerCase(), detail: { recomputed } });
  checks.push({ name: "entry hash recomputes", ok: computeEntryHash(entry.prevHash, entry).toLowerCase() === entry.entryHash.toLowerCase() });

  // anchor: scan LogAnchor ranges (newest first) on the snapshot's chain, then 97 as a fallback
  const anchorChains = [chainId, ...[97, 56].filter((x) => x !== chainId)];
  let anchored: Check = { name: "an on-chain LogAnchor range covers the entry", ok: false };
  for (const cid of anchorChains) {
    const la = loadDeployments(cid)?.core.logAnchor;
    if (!la) continue;
    const pc = publicClient(chainKindOf(cid));
    try {
      const n = Number(await pc.readContract({ address: la, abi: logAnchorAbi, functionName: "count" }));
      for (let i = n - 1; i >= 0; i--) {
        const a = await pc.readContract({ address: la, abi: logAnchorAbi, functionName: "anchorAt", args: [BigInt(i)] });
        if (Number(a.fromSeq) <= seq && seq <= Number(a.toSeq)) {
          const range = await src.range(Number(a.fromSeq), Number(a.toSeq));
          const leaves = range.map((x) => x.entryHash);
          const root = leaves.length ? merkleRoot(leaves) : undefined;
          const idx = seq - Number(a.fromSeq);
          const proof = leaves.length > idx ? merkleProof(leaves, idx) : [];
          const ok = root?.toLowerCase() === a.root.toLowerCase() && verifyProof(entry.entryHash, proof, a.root);
          anchored = { name: "an on-chain LogAnchor range covers the entry", ok, detail: { chainId: cid, logAnchor: la, index: i, fromSeq: Number(a.fromSeq), toSeq: Number(a.toSeq), root: a.root, proofLength: proof.length } };
          break;
        }
        if (Number(a.toSeq) < seq) break;
      }
    } catch (e) {
      anchored = { name: anchored.name, ok: false, detail: { chainId: cid, error: String(e) } };
    }
    if (anchored.ok) break;
  }
  if (!anchored.ok && !anchored.detail) anchored.detail = "not anchored yet (anchors are hourly)";
  checks.push(anchored);
  return { ok: checks.every((x) => x.ok), tx, chainId, snapshotId: seq, checks };
}
