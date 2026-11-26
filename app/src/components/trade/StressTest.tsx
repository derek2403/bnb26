"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePublicClient, useReadContracts } from "wagmi";
import { bscTestnet } from "viem/chains";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { BackstopVaultAbi, LeveragePoolAbi, RiskOracleAbi, ScenarioFeedAbi } from "@/abi";
import { addr, deployments97, launcherForPool, oracleFor } from "@/config/deployments";
import { txUrl } from "@/config/chains";
import { metaFromDeployed, usePool } from "@/hooks/usePools";
import { describeError, useTx } from "@/hooks/useTx";
import { fmtLev, fmtNum, fmtPct, fmtUsd, toNum } from "@/lib/format";
import * as sim from "@/lib/sim";
import type { PoolMeta, PoolSnapshot } from "@/lib/types";
import { Addr, CrGauge, LeverageGauge, ModePill, SplitBar } from "../ui";

type Result = { id: number; label: string; text: string; tone: "good" | "bad" | "warn" | "muted"; txs: Hex[] };
type StateLite = { price: number; lev: number; cr: number; mode: string };
const MODE_NAMES = ["UNSEEDED", "NORMAL", "STABILITY", "UNDERWATER", "NO_PRICE"];
const toneCls = (t: Result["tone"]) => (t === "good" ? "text-good" : t === "bad" ? "text-bad" : t === "warn" ? "text-warn" : "text-muted");
const crTxt = (v: number) => (Number.isFinite(v) ? fmtPct(v, 0) : "∞");

/** Right-hand drawer: shock a sandbox copy of the market and watch the pool defend itself. */
export function StressDrawer({ symbol, demoSnap, open, onClose }: { symbol: string; demoSnap?: PoolSnapshot | null; open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open, onClose]);
  const shared = deployments97.pools.find((p) => p.kind === "scenario" && p.symbol === symbol);
  const meta = useMemo(() => (shared && !demoSnap ? metaFromDeployed(shared) : undefined), [shared, demoSnap]);
  const feed = shared ? addr(shared.feed) ?? addr(oracleFor(shared.symbol)?.scenarioFeed) : undefined;
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Stress test">
      <button className="absolute inset-0 bg-black/40" aria-label="Close stress test" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-[480px] flex-col border-l border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-ink">Stress test · {symbol}</div>
            <div className="text-xs text-warn">Simulation on a sandbox pool. Your position and the live market are not touched.</div>
          </div>
          <button className="btn btn-sm h-8 w-8 px-0" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {meta && feed ? <OnchainStress meta={meta} feed={feed} /> : <OfflineStress symbol={symbol} snap={demoSnap ?? null} />}
        </div>
      </aside>
    </div>
  );
}

function PoolMini({ snap, title, right }: { snap: PoolSnapshot | null; title: string; right?: ReactNode }) {
  return (
    <div className="rounded border border-line p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="label">{title}</span>
        <span className="flex items-center gap-2">
          {right}
          {snap && <ModePill mode={snap.mode} />}
        </span>
      </div>
      {snap ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div className="label">Price</div>
              <div className="num text-sm text-ink">{fmtUsd(snap.price)}</div>
            </div>
            <div>
              <div className="label">Leverage</div>
              <div className="num text-sm text-lever">{fmtLev(snap.leverage)}</div>
            </div>
            <div>
              <div className="label">sUSD backing</div>
              <div className="num text-sm text-stable">{crTxt(snap.cr)}</div>
            </div>
          </div>
          <LeverageGauge snap={snap} />
          <CrGauge snap={snap} />
          <SplitBar snap={snap} />
        </div>
      ) : (
        <div className="py-4 text-center text-xs text-muted">Reading the sandbox pool…</div>
      )}
    </div>
  );
}

function Buttons({ items, disabled, busy }: { items: { key: string; label: string; title: string; hint: string; tone: string; onClick: () => void }[]; disabled: boolean; busy: string | null }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map((b) => (
        <button key={b.key} className="flex flex-col items-start gap-0.5 rounded border border-line bg-surface p-2.5 text-left transition-colors hover:bg-surface2 disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={b.onClick}>
          <span className="flex w-full items-baseline justify-between gap-2">
            <span className={`num text-sm font-semibold ${b.tone}`}>{b.label}</span>
            <span className="text-2xs text-faint">{busy === b.key ? "running…" : b.title}</span>
          </span>
          <span className="text-2xs leading-snug text-muted">{b.hint}</span>
        </button>
      ))}
    </div>
  );
}

function Log({ results }: { results: Result[] }) {
  if (!results.length) return <p className="text-xs text-faint">Pick a scenario. Each step reads the pool before and after, and links every transaction.</p>;
  return (
    <ul className="space-y-1.5">
      {results.map((r) => (
        <li key={r.id} className="rounded border border-line px-3 py-2 text-xs">
          <div className={toneCls(r.tone)}>
            <b className="text-ink">{r.label}</b> · {r.text}
          </div>
          {r.txs.length > 0 && (
            <div className="mt-1 flex gap-3">
              {r.txs.map((h, i) => (
                <a key={h} className="num link" href={txUrl(h)} target="_blank" rel="noreferrer">
                  tx{r.txs.length > 1 ? ` ${i + 1}` : ""} ↗
                </a>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function OnchainStress({ meta, feed }: { meta: PoolMeta; feed: Address }) {
  const { send, pending, account } = useTx();
  const client = usePublicClient({ chainId: bscTestnet.id });
  const d = usePool(meta.id, meta);
  const pool = meta.addresses!.pool;
  const assetId = meta.assetId ?? keccak256(toBytes(meta.symbol));
  const ro = addr(deployments97.core.riskOracle);
  const vault = addr(launcherForPool("nvda-flap")?.vault);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const info = useReadContracts({
    allowFailure: true,
    query: { refetchInterval: 15_000 },
    contracts: [
      { address: feed, abi: ScenarioFeedAbi, functionName: "anchor", chainId: bscTestnet.id },
      { address: feed, abi: ScenarioFeedAbi, functionName: "operator", chainId: bscTestnet.id },
      { address: feed, abi: ScenarioFeedAbi, functionName: "publicSetter", chainId: bscTestnet.id },
      { address: feed, abi: ScenarioFeedAbi, functionName: "decimals", chainId: bscTestnet.id },
      { address: pool, abi: LeveragePoolAbi, functionName: "currentRisk", chainId: bscTestnet.id },
      ro ? { address: ro, abi: RiskOracleAbi, functionName: "refPrice", args: [assetId], chainId: bscTestnet.id } : { address: feed, abi: ScenarioFeedAbi, functionName: "anchor", chainId: bscTestnet.id },
      vault ? { address: vault, abi: BackstopVaultAbi, functionName: "scenarioPool", chainId: bscTestnet.id } : { address: feed, abi: ScenarioFeedAbi, functionName: "operator", chainId: bscTestnet.id },
    ],
  });
  const at = <T,>(i: number): T | undefined => (info.data?.[i]?.status === "success" ? (info.data[i].result as T) : undefined);
  const anchor = at<bigint>(0);
  const operator = at<Address>(1);
  const publicSetter = at<boolean>(2) ?? false;
  const dec = Number(at<number>(3) ?? 8);
  const risk = at<readonly [{ maxDevBps: bigint }, bigint]>(4);
  const maxDevBps = risk ? Number(risk[0].maxDevBps) : 150;
  const ref = ro ? at<readonly [bigint, bigint]>(5) : undefined;
  const refWad = ref?.[0] ?? 0n;
  const vaultScenario = vault ? at<Address>(6) : undefined;
  const canCover = !!vault && !!vaultScenario && vaultScenario.toLowerCase() === pool.toLowerCase();
  const canSet = publicSetter || (!!account && !!operator && operator.toLowerCase() === account.toLowerCase());
  const scale = 10n ** BigInt(Math.max(0, 18 - dec));
  const usd = (feedUnits: bigint) => Number(feedUnits) / 10 ** dec;

  const readState = async (): Promise<StateLite | null> => {
    if (!client) return null;
    try {
      const st = (await client.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "state" })) as { price: bigint; leverage: bigint; collateralRatio: bigint; mode: number };
      return { price: toNum(st.price), lev: toNum(st.leverage), cr: toNum(st.collateralRatio), mode: MODE_NAMES[st.mode] ?? String(st.mode) };
    } catch {
      return null;
    }
  };
  const log = (r: Omit<Result, "id">) => setResults((x) => [{ ...r, id: Date.now() + Math.random() }, ...x].slice(0, 8));
  const setPrice = (answer: bigint, label: string) => send({ address: feed, abi: ScenarioFeedAbi, functionName: "setPrice", args: [answer], label });
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
      d.refetch();
      void info.refetch();
    }
  };

  // −22% from the anchor, then rebalance(): the sell zone sells stock for mUSDC and brings leverage back to target.
  const sellZone = () =>
    run("sell", async () => {
      if (!anchor) return;
      const r1 = await setPrice((anchor * 7800n) / 10000n, "Sandbox price −22%");
      if (!r1) return;
      const mid = await readState();
      const txs: Hex[] = [r1.transactionHash];
      type Pv = { zone: number; executable: boolean; cooldownLeft: bigint };
      let pv: Pv | null = null;
      try {
        pv = (await client!.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewRebalance" })) as Pv;
      } catch {
        pv = null;
      }
      if (pv && pv.zone !== 0 && pv.executable) {
        const r2 = await send({ address: pool, abi: LeveragePoolAbi, functionName: "rebalance", label: "Sell zone (rebalance)" });
        if (r2) txs.push(r2.transactionHash);
      }
      const end = await readState();
      if (mid && end && txs.length > 1) log({ label: "−22%", tone: "good", txs, text: `Price ${fmtUsd(mid.price)}: leverage jumped to ${fmtLev(mid.lev)}. The sell zone sold stock for mUSDC: leverage back to ${fmtLev(end.lev)}.` });
      else if (mid) {
        const why = !pv ? "previewRebalance() failed" : pv.zone === 0 ? "leverage still inside the band" : pv.cooldownLeft > 0n ? `cooldown ${pv.cooldownLeft}s` : "not executable right now";
        log({ label: "−22%", tone: "warn", txs, text: `Price ${fmtUsd(mid.price)}: leverage ${fmtLev(mid.lev)}. Sell zone did not run (${why}).` });
      }
    });

  // Move the feed away from the on-chain CMC reference by twice the breaker limit, then check a mint.
  const cmcGap = () =>
    run("cmc", async () => {
      if (!anchor) return;
      const devBps = BigInt(Math.max(300, maxDevBps * 2));
      const target = refWad > 0n ? (refWad * (10000n - devBps)) / 10000n / scale : (anchor * (10000n - devBps)) / 10000n;
      const r1 = await setPrice(target, "Sandbox CMC gap");
      if (!r1) return;
      const txs: Hex[] = [r1.transactionHash];
      const unit = 10n ** BigInt(d.decimals.asset);
      try {
        const [out] = await client!.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewMintStable", args: [unit] });
        log({ label: "CMC gap", tone: "warn", txs, text: `Price ${fmtUsd(usd(target))} vs CMC ${refWad ? fmtUsd(toNum(refWad)) : "–"}: a mint would still succeed (${fmtNum(toNum(out))} sUSD).` });
      } catch (e) {
        log({ label: "CMC gap", tone: "bad", txs, text: `Atlas ${fmtUsd(usd(target))} vs CMC ${refWad ? fmtUsd(toNum(refWad)) : "–"}: ${(Number(devBps) / 100).toFixed(1)}% apart, limit ${(maxDevBps / 100).toFixed(1)}%. Minting is blocked; closing still works. ${describeError(e).split("[")[0]}` });
      }
    });

  // −55% from the anchor: the pool goes underwater and the insurance vault covers the gap.
  const crash = () =>
    run("crash", async () => {
      if (!anchor) return;
      const r1 = await setPrice((anchor * 4500n) / 10000n, "Sandbox price −55%");
      if (!r1) return;
      const mid = await readState();
      const txs: Hex[] = [r1.transactionHash];
      if (!mid) return;
      if (mid.cr >= 1) return log({ label: "−55%", tone: "warn", txs, text: `Price ${fmtUsd(mid.price)}: backing ${crTxt(mid.cr)}, still ≥ 100%, so the insurance vault is not needed. Reset first if the sell zone already ran.` });
      if (!canCover) return log({ label: "−55%", tone: "bad", txs, text: `Price ${fmtUsd(mid.price)}: backing ${crTxt(mid.cr)} (${mid.mode}). No insurance vault is attached to this sandbox, so sUSD would redeem pro rata.` });
      let ready = false;
      let bufUsd = 0;
      try {
        const [ok, b] = await Promise.all([
          client!.readContract({ address: vault!, abi: BackstopVaultAbi, functionName: "canCover", args: [pool] }) as Promise<boolean>,
          client!.readContract({ address: vault!, abi: BackstopVaultAbi, functionName: "bufferUsd" }) as Promise<bigint>,
        ]);
        ready = ok;
        bufUsd = toNum(b);
      } catch {
        ready = true;
      }
      if (!ready) return log({ label: "−55%", tone: "bad", txs, text: `Price ${fmtUsd(mid.price)}: backing ${crTxt(mid.cr)} (${mid.mode}). The insurance vault holds ${fmtUsd(bufUsd)} and cannot cover yet: sUSD redeems pro rata at ${crTxt(mid.cr)}.` });
      const r2 = await send({ address: vault!, abi: BackstopVaultAbi, functionName: "cover", args: [pool], label: "Insurance vault cover" });
      if (r2) txs.push(r2.transactionHash);
      const end = await readState();
      log({ label: "−55%", tone: r2 ? "good" : "bad", txs, text: r2 && end ? `Price ${fmtUsd(mid.price)}: backing fell to ${crTxt(mid.cr)}. The insurance vault covered: backing now ${crTxt(end.cr)} (${end.mode}).` : `Price ${fmtUsd(mid.price)}: backing ${crTxt(mid.cr)}. The cover call failed (see the notification).` });
    });

  const reset = () =>
    run("reset", async () => {
      const r = await send({ address: feed, abi: ScenarioFeedAbi, functionName: "reset", label: "Reset sandbox price" });
      if (!r) return;
      const end = await readState();
      log({ label: "Reset", tone: "muted", txs: [r.transactionHash], text: end ? `Price back to the Atlas anchor ${fmtUsd(end.price)}: leverage ${fmtLev(end.lev)}, backing ${crTxt(end.cr)}.` : "Price back to the Atlas anchor." });
    });

  const items = [
    { key: "sell", label: "−22%", title: "Sell zone", hint: "Leverage jumps; the pool sells stock for USDC by itself.", tone: "text-bad", onClick: sellZone },
    { key: "cmc", label: "CMC gap", title: "Mint breaker", hint: `Price ${Math.max(3, (maxDevBps * 2) / 100).toFixed(0)}% off the CMC reference: minting stops.`, tone: "text-warn", onClick: cmcGap },
    { key: "crash", label: "−55%", title: "Insurance", hint: canCover ? "A gap crash: the insurance vault covers the shortfall." : "Underwater: shows the loss order.", tone: "text-bad", onClick: crash },
    { key: "reset", label: "Reset", title: "Back to Atlas", hint: "Sandbox price back to the live Atlas price.", tone: "text-ink", onClick: reset },
  ];

  return (
    <div className="space-y-4">
      <PoolMini snap={d.snap} title="Sandbox pool" right={<Addr a={pool} />} />
      <div className="num flex flex-wrap gap-x-3 text-2xs text-faint">
        <span>anchor {anchor ? fmtUsd(usd(anchor)) : "…"}</span>
        <span>CMC ref {refWad ? fmtUsd(toNum(refWad)) : "–"}</span>
        <span>breaker ±{(maxDevBps / 100).toFixed(1)}%</span>
      </div>
      {!canSet && operator && (
        <p className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-ink">
          Only the sandbox operator <Addr a={operator} /> can move this price. Connect that wallet to run the steps.
        </p>
      )}
      <Buttons items={items} disabled={!!pending || !!busy || !anchor || !canSet} busy={busy} />
      <p className="text-2xs leading-relaxed text-faint">Order for a clean run: CMC gap → −55% → Reset → −22%. The sell zone moves stock into USDC for good, so a crash after it stays above 100% backing.</p>
      <Log results={results} />
    </div>
  );
}

function initialSim(price: number): sim.SimState {
  const V = 1_000_000;
  const E = V / 2;
  return { C: V / price, U: 0, S: V - E, X: E, P: price, anchor: price, spDeposits: 120_000, vaultBufferUsd: 25_000, params: { ...sim.DEFAULT_SIM_PARAMS }, marketOpen: true, gapGuard: false, priceUpdatedAt: Math.floor(Date.now() / 1000), snapshotId: 1, riskSource: "RULE" };
}

/** Local simulation (demo markets, or when no sandbox pool exists for the asset). */
function OfflineStress({ symbol, snap: live }: { symbol: string; snap: PoolSnapshot | null }) {
  const base = useMemo(() => (live ? sim.fromSnapshot(live) : initialSim(180)), [live?.price ? Math.round(live.price) : 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const [s, setS] = useState<sim.SimState | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const state = s ?? base;
  const snap = sim.toSnapshot(state);
  const log = (label: string, text: string, tone: Result["tone"]) => setResults((x) => [{ id: Date.now() + Math.random(), label, text, tone, txs: [] }, ...x].slice(0, 8));
  const shock = (bps: number, label: string) => {
    const next = sim.shock(state, bps);
    const d = sim.derive(next);
    if (bps <= -5000) {
      const w = sim.waterfall(next);
      setS(w.state);
      log(label, `Price ${fmtUsd(next.P)}: backing fell to ${crTxt(d.CR)}. ${w.steps.filter((x) => x.done).map((x) => x.step).join(" → ") || "No step needed"}. sUSD pays ${fmtUsd(w.payoutPerSusd, { digits: 4 })}.`, w.payoutPerSusd >= 0.999 ? "good" : "bad");
    } else {
      const r = sim.previewRebalance(next);
      setS(r.state);
      log(label, `Price ${fmtUsd(next.P)}: leverage ${fmtLev(d.L)}. ${r.note}`, r.zone === "NONE" ? "warn" : "good");
    }
  };
  const items = [
    { key: "sell", label: "−22%", title: "Sell zone", hint: "Leverage jumps; the pool sells stock for USDC by itself.", tone: "text-bad", onClick: () => shock(-2200, "−22%") },
    { key: "cmc", label: "CMC gap", title: "Mint breaker", hint: "Price far from the CMC reference: minting stops.", tone: "text-warn", onClick: () => log("CMC gap", "Price 3% off the CMC reference: new mints revert with BreakerTripped. Closing still works.", "bad") },
    { key: "crash", label: "−55%", title: "Insurance", hint: "A gap crash: Stability Pool, then the insurance vault.", tone: "text-bad", onClick: () => shock(-5500, "−55%") },
    { key: "reset", label: "Reset", title: "Back to live", hint: "Start again from the market's current state.", tone: "text-ink", onClick: () => { setS(null); setResults([]); } },
  ];
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">{live ? `Local simulation of the ${symbol} market, starting from its current state.` : `No sandbox pool for ${symbol}: this runs the same math locally.`}</p>
      <PoolMini snap={snap} title="Simulated pool" />
      <Buttons items={items} disabled={false} busy={null} />
      <Log results={results} />
    </div>
  );
}
