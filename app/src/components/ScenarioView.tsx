"use client";
import { useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts, usePublicClient } from "wagmi";
import { bscTestnet } from "viem/chains";
import { keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import { BackstopVaultAbi, LeveragePoolAbi, RiskOracleAbi, SandboxFactoryAbi, ScenarioFeedAbi } from "@/abi";
import { addr, deployments97, launcherForPool, oracleFor } from "@/config/deployments";
import { txUrl } from "@/config/chains";
import { REFERENCE_FALLBACK } from "@/config/demoPools";
import { metaForSandbox, metaFromDeployed, useDemoPrices, usePool } from "@/hooks/usePools";
import { describeError, useTx } from "@/hooks/useTx";
import { fmtLev, fmtNum, fmtPct, fmtUsd, toNum } from "@/lib/format";
import * as sim from "@/lib/sim";
import type { PoolMeta, PoolSnapshot } from "@/lib/types";
import { PoolDetailView } from "./PoolDetailView";
import { Addr, Card, CrGauge, KV, LeverageGauge, ModePill, SplitBar, Stat, Tabs } from "./ui";

const SHOCKS = [
  { bps: -2200, label: "−22%", hint: "Sell zone fires; a new mint trips the CMC deviation breaker." },
  { bps: 3500, label: "+35%", hint: "Leverage falls below the lower trigger: the buy zone fires." },
  { bps: -5500, label: "−55%", hint: "Stability mode, then Stability Pool absorbs, vault covers, pro-rata haircut." },
];

type Mode = "sandbox" | "shared" | "offline";

export function ScenarioView() {
  const { address } = useAccount();
  const sandboxFactory = addr(deployments97.core.sandboxFactory);
  // The demo uses the canonical NVDA ScenarioPool: the Flap BackstopVault can cover it (scene 4, -55%).
  const shared = deployments97.pools.find((p) => p.id === "nvda-scenario") ?? deployments97.pools.find((p) => p.kind === "scenario");
  const [mode, setMode] = useState<Mode>(shared ? "shared" : sandboxFactory ? "sandbox" : "offline");
  const sharedMeta = useMemo(() => (shared ? metaFromDeployed(shared) : undefined), [shared]);
  const sharedFeed = shared ? addr(shared.feed) ?? addr(oracleFor(shared.symbol)?.scenarioFeed) : undefined;

  const sb = useReadContract({
    address: sandboxFactory,
    abi: SandboxFactoryAbi,
    functionName: "sandboxOf",
    args: [address ?? zeroAddress],
    chainId: bscTestnet.id,
    query: { enabled: !!sandboxFactory && !!address, refetchInterval: 15_000 },
  });
  const mySandbox = sb.data && sb.data.pool !== zeroAddress ? (sb.data as { pool: Address; feed: Address }) : null;

  const items = [
    ...(shared ? [{ value: "shared" as const, label: `ScenarioPool (${shared.symbol})` }] : []),
    ...(sandboxFactory ? [{ value: "sandbox" as const, label: "My sandbox" }] : []),
    { value: "offline" as const, label: "Offline simulation" },
  ];

  return (
    <div className="space-y-5">
      <div className="rounded-card border-2 border-warn/60 bg-warn/10 px-4 py-3 text-sm text-ink">
        <span className="font-semibold">SCENARIO</span> · The price here is set on a ScenarioFeed (bounded to 0.4–1.6× its Atlas anchor), not by Atlas itself.
        Same pool code, same CMC limits. Nothing on this page touches the live NVDA or TSLA pools.
      </div>
      <Tabs value={mode} onChange={setMode} items={items} />
      {mode === "sandbox" && <SandboxMode factory={sandboxFactory!} sandbox={mySandbox} refetch={() => void sb.refetch()} connected={!!address} />}
      {mode === "shared" && shared && sharedMeta && sharedFeed && <OnchainScenario meta={sharedMeta} feed={sharedFeed} />}
      {mode === "shared" && shared && !sharedFeed && <Card title="ScenarioPool">The ScenarioPool has no feed in deployments/97.json (pools[].feed or oracles.{shared.symbol}.scenarioFeed).</Card>}
      {mode === "offline" && <OfflineScenario />}
    </div>
  );
}

function SandboxMode({ factory, sandbox, refetch, connected }: { factory: Address; sandbox: { pool: Address; feed: Address } | null; refetch: () => void; connected: boolean }) {
  const { send, pending } = useTx();
  if (!sandbox) {
    return (
      <Card title="Your private sandbox">
        <p className="text-sm text-muted">
          SandboxFactory.create() deploys your own pool, sUSD/x tokens, StabilityPool and a ScenarioFeed you control, anchored to the live NVDA mirror.
          It seeds the pool, sends you the xNVDA and tries a first sUSD mint for you.
        </p>
        <button
          className="btn-primary mt-4"
          disabled={!!pending}
          onClick={async () => {
            await send({ address: factory, abi: SandboxFactoryAbi, functionName: "create", label: "Create sandbox" });
            refetch();
          }}
        >
          {pending ?? (connected ? "Create my sandbox" : "Connect wallet to create")}
        </button>
      </Card>
    );
  }
  return <OnchainScenario meta={metaForSandbox(sandbox.pool, sandbox.feed)} feed={sandbox.feed} />;
}

type StateLite = { price: number; lev: number; cr: number; mode: string };
type Result = { id: number; label: string; text: string; tone: "good" | "bad" | "warn" | "muted"; txs: Hex[] };
const MODE_NAMES = ["UNSEEDED", "NORMAL", "STABILITY", "UNDERWATER", "NO_PRICE"];

function OnchainScenario({ meta, feed }: { meta: PoolMeta; feed: Address }) {
  const { send, pending, account } = useTx();
  const client = usePublicClient({ chainId: bscTestnet.id });
  const d = usePool(meta.id, meta);
  const pool = meta.addresses!.pool;
  const assetId = meta.assetId ?? keccak256(toBytes(meta.symbol));
  const ro = addr(deployments97.core.riskOracle);
  const vault = meta.source === "scenario" ? addr(launcherForPool("nvda-flap")?.vault) : undefined;
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [more, setMore] = useState(false);

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
  const cr = (v: number) => (Number.isFinite(v) ? fmtPct(v, 0) : "∞");
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

  // Scene 4a: -22% from the anchor, then rebalance(): the sell zone brings leverage back to target.
  const sellZone = () =>
    run("sell", async () => {
      if (!anchor) return;
      const r1 = await setPrice((anchor * 7800n) / 10000n, "Price −22%");
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
      if (mid && end && txs.length > 1) {
        log({ label: "−22%", tone: "good", txs, text: `Price ${fmtUsd(mid.price)}: leverage hit ${fmtLev(mid.lev)}. The sell zone sold stock for mUSDC: leverage back to ${fmtLev(end.lev)}.` });
      } else if (mid) {
        const why = !pv ? "previewRebalance() failed" : pv.zone === 0 ? "leverage is still inside the band" : pv.cooldownLeft > 0n ? `cooldown ${pv.cooldownLeft}s` : "not executable right now";
        log({ label: "−22%", tone: "warn", txs, text: `Price ${fmtUsd(mid.price)}: leverage ${fmtLev(mid.lev)}. Sell zone did not run (${why}).` });
      }
    });

  // Scene 4b: move the feed away from the on-chain CMC reference by twice the breaker limit, then try a mint.
  const cmcShock = () =>
    run("cmc", async () => {
      if (!anchor) return;
      const devBps = BigInt(Math.max(300, maxDevBps * 2));
      const target = refWad > 0n ? (refWad * (10000n - devBps)) / 10000n / scale : (anchor * (10000n - devBps)) / 10000n;
      const r1 = await setPrice(target, "CMC deviation shock");
      if (!r1) return;
      const txs: Hex[] = [r1.transactionHash];
      const unit = 10n ** BigInt(d.decimals.asset);
      try {
        const [out] = await client!.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewMintStable", args: [unit] });
        log({ label: "CMC deviation", tone: "warn", txs, text: `Price ${fmtUsd(usd(target))} vs CMC ${refWad ? fmtUsd(toNum(refWad)) : "–"}: a 1 ${meta.assetSymbol} mint would still succeed (${fmtNum(toNum(out))} sUSD).` });
      } catch (e) {
        log({ label: "CMC deviation", tone: "bad", txs, text: `Atlas side ${fmtUsd(usd(target))} vs CMC ${refWad ? fmtUsd(toNum(refWad)) : "–"}: ${(Number(devBps) / 100).toFixed(1)}% apart, limit ${(maxDevBps / 100).toFixed(1)}%. Mint blocked by the breaker. ${describeError(e)}` });
      }
    });

  // Scene 4c: -55% from the anchor: the pool goes underwater and the Flap tax vault covers the gap.
  const crash = () =>
    run("crash", async () => {
      if (!anchor) return;
      const r1 = await setPrice((anchor * 4500n) / 10000n, "Price −55%");
      if (!r1) return;
      const mid = await readState();
      const txs: Hex[] = [r1.transactionHash];
      if (!mid) return;
      if (mid.cr >= 1) {
        log({ label: "−55%", tone: "warn", txs, text: `Price ${fmtUsd(mid.price)}: CR ${cr(mid.cr)}, still ≥ 100%, so the backstop is not needed.` });
        return;
      }
      if (!canCover) {
        log({ label: "−55%", tone: "bad", txs, text: `Price ${fmtUsd(mid.price)}: CR ${cr(mid.cr)} (${mid.mode}). The backstop vault covers only the shared ScenarioPool, so here sUSD would redeem pro rata.` });
        return;
      }
      // Ask the vault first: with an empty buffer (no SPLIT tax dispatched yet) or a spent tranche cap, cover() would
      // revert NothingToCover / EpochCapReached. Explain the loss order instead of sending a failing tx.
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
        ready = true; // unknown: let the tx (and its toast) decide
      }
      if (!ready) {
        log({
          label: "−55%",
          tone: "bad",
          txs,
          text: `Price ${fmtUsd(mid.price)}: CR ${cr(mid.cr)} (${mid.mode}). The Flap tax vault holds ${fmtUsd(bufUsd)} (its buffer fills when SPLIT tax is dispatched), so it cannot cover yet: sUSD redeems pro rata at ${cr(mid.cr)}.`,
        });
        return;
      }
      const r2 = await send({ address: vault!, abi: BackstopVaultAbi, functionName: "cover", args: [pool], label: "Backstop cover" });
      if (r2) txs.push(r2.transactionHash);
      const end = await readState();
      log({
        label: "−55%",
        tone: r2 ? "good" : "bad",
        txs,
        text: r2 && end ? `Price ${fmtUsd(mid.price)}: CR fell to ${cr(mid.cr)}. The Flap tax vault covered: CR now ${cr(end.cr)} (${end.mode}).` : `Price ${fmtUsd(mid.price)}: CR ${cr(mid.cr)}. The cover call failed (see the toast).`,
      });
    });

  const reset = () =>
    run("reset", async () => {
      const r = await send({ address: feed, abi: ScenarioFeedAbi, functionName: "reset", label: "Reset price" });
      if (!r) return;
      const end = await readState();
      log({ label: "Reset", tone: "muted", txs: [r.transactionHash], text: end ? `Price back to the Atlas anchor ${fmtUsd(end.price)}: leverage ${fmtLev(end.lev)}, CR ${cr(end.cr)}.` : "Price back to the Atlas anchor." });
    });

  // Click order matters: −22% runs the sell zone, which moves stock into mUSDC for good, and afterwards even the
  // feed floor (−60%) leaves CR above 100%. So the gap crash (−55%) comes first, from ~2x; Reset puts the price
  // back (the pool's C/U are unchanged), then −22% shows the sell zone. Reset again before a retake and re-run
  // services/scripts/scenario-prep-97.sh after a −22% run.
  const BUTTONS = [
    { key: "cmc", label: "CMC deviation", title: "Breaker", hint: `Price ${Math.max(3, (maxDevBps * 2) / 100).toFixed(0)}% off the CMC reference: minting stops.`, onClick: cmcShock, tone: "text-warn" },
    { key: "crash", label: "−55%", title: "Backstop cover", hint: canCover ? "A gap from ~2x: underwater, the Flap tax vault steps in." : "Underwater: shows the loss order.", onClick: crash, tone: "text-bad" },
    { key: "reset", label: "Reset", title: "Back to Atlas", hint: "Price back to the live Atlas anchor.", onClick: reset, tone: "text-ink" },
    { key: "sell", label: "−22%", title: "Sell zone", hint: "Leverage jumps; the pool sells stock for USDC itself.", onClick: sellZone, tone: "text-bad" },
  ];
  const disabled = !!pending || !!busy || !anchor || !canSet;

  return (
    <div className="space-y-5">
      <Card
        title={`Shock the ${meta.symbol} price`}
        right={<span className="text-xs text-muted">anchor {anchor ? fmtUsd(usd(anchor)) : "…"} · CMC ref {refWad ? fmtUsd(toNum(refWad)) : "–"} · breaker {(maxDevBps / 100).toFixed(1)}%</span>}
      >
        {!canSet && operator && (
          <p className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-ink">
            Only the feed operator <Addr a={operator} /> can move this price. {account ? "Connect that wallet, or use My sandbox." : "Connect the operator wallet, or use My sandbox."}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {BUTTONS.map((b) => (
            <button key={b.key} className="btn flex-col items-start text-left" disabled={disabled} onClick={b.onClick}>
              <span className="flex w-full items-baseline justify-between gap-2">
                <span className={`num text-base font-semibold ${b.tone}`}>{b.label}</span>
                <span className="text-[11px] font-normal text-faint">{busy === b.key ? "running…" : b.title}</span>
              </span>
              <span className="text-xs font-normal text-muted">{b.hint}</span>
            </button>
          ))}
        </div>
        {results.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {results.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 rounded-lg bg-surface2 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                <span className={r.tone === "good" ? "text-good" : r.tone === "bad" ? "text-bad" : r.tone === "warn" ? "text-warn" : "text-muted"}>
                  <b className="text-ink">{r.label}</b> · {r.text}
                </span>
                <span className="flex shrink-0 gap-2">
                  {r.txs.map((h, i) => (
                    <a key={h} className="num link" href={txUrl(h)} target="_blank" rel="noreferrer">
                      tx{r.txs.length > 1 ? ` ${i + 1}` : ""} ↗
                    </a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <button className="text-xs text-muted hover:text-ink" onClick={() => setMore((m) => !m)}>
            {more ? "▾" : "▸"} More controls
          </button>
          {more && <MoreControls pool={pool} feed={feed} meta={meta} refetch={d.refetch} disabled={!!pending || !canSet} />}
        </div>
      </Card>
      {d.snap && <PreOpenPreview snap={d.snap} />}
      <PoolDetailView id={meta.id} override={meta} />
    </div>
  );
}

function MoreControls({ pool, feed, meta, refetch, disabled }: { pool: Address; feed: Address; meta: PoolMeta; refetch: () => void; disabled: boolean }) {
  const { send, pending } = useTx();
  const client = usePublicClient({ chainId: bscTestnet.id });
  const [check, setCheck] = useState<string | null>(null);
  const preview = useReadContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewRebalance", chainId: bscTestnet.id, query: { refetchInterval: 10_000 } });
  const ZONE = ["NONE", "SELL", "BUY"];
  const ROUTE = ["DEX", "STABILITY_POOL"];
  const tryMint = async () => {
    if (!client) return;
    try {
      const [out, fee] = await client.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewMintStable", args: [10n ** 18n] });
      setCheck(`mintStable(1 ${meta.assetSymbol}) would succeed: ${(Number(out) / 1e18).toFixed(2)} sUSD at ${Number(fee) / 100}% fee.`);
    } catch (e) {
      setCheck(`mintStable(1 ${meta.assetSymbol}) is blocked: ${describeError(e)}`);
    }
  };
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-sm" disabled={disabled} onClick={() => send({ address: feed, abi: ScenarioFeedAbi, functionName: "shock", args: [3500n], label: "Shock +35%" }).then(refetch)}>
          +35% (buy zone)
        </button>
        <button className="btn btn-sm" disabled={!!pending} onClick={() => send({ address: pool, abi: LeveragePoolAbi, functionName: "rebalance", label: "Rebalance" }).then(refetch)}>
          Run rebalance()
        </button>
        <button className="btn btn-sm" onClick={tryMint}>
          Check a 1 {meta.assetSymbol} mint
        </button>
      </div>
      {check && <p className="rounded-lg bg-surface2 px-3 py-2 font-mono text-xs text-ink">{check}</p>}
      {preview.data && (
        <p className="text-xs text-muted">
          previewRebalance(): zone <b className="text-ink">{ZONE[preview.data.zone]}</b> via {ROUTE[preview.data.route]}, size {fmtUsd(Number(preview.data.sizeUsd) / 1e18)}, chunk{" "}
          {fmtUsd(Number(preview.data.chunkUsd) / 1e18)}
          {preview.data.cooldownLeft > 0n ? `, cooldown ${preview.data.cooldownLeft}s` : ""} · {preview.data.executable ? "executable" : "not executable now"}
        </p>
      )}
    </div>
  );
}

/** "Skip to pre-open": project the gap guard onto the current state (block time cannot be moved on-chain). */
function PreOpenPreview({ snap }: { snap: PoolSnapshot }) {
  const [shown, setShown] = useState(false);
  const proj = useMemo(() => {
    const s = sim.fromSnapshot(snap);
    s.marketOpen = false;
    s.gapGuard = true;
    return { eff: sim.effective(s), r: sim.previewRebalance(s) };
  }, [snap]);
  return (
    <Card title="Skip to pre-open (gap guard)" right={<button className="btn btn-sm" onClick={() => setShown((v) => !v)}>{shown ? "Hide" : "Skip to pre-open"}</button>}>
      {shown ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <KV k="Trigger now → in gap window" v={`${fmtLev(snap.triggerLev)} → ${fmtLev(proj.eff.trigger)}`} />
            <KV k="Target now → in gap window" v={`${fmtLev(snap.targetLev)} → ${fmtLev(proj.eff.target)}`} />
            <KV k="Mint cap (closed)" v={fmtLev(proj.eff.maxMint)} />
          </div>
          <div className="text-sm text-muted">
            <p>
              Leverage {fmtLev(snap.leverage)} vs gap trigger {fmtLev(proj.eff.trigger)}: <b className="text-ink">{proj.r.zone === "NONE" ? "no action" : `${proj.r.zone} zone`}</b>.
            </p>
            <p className="mt-1">{proj.r.note}</p>
            <p className="mt-2 text-xs text-faint">Projected locally from pool.state(); on-chain the MarketCalendar switches the gap guard on in the hour before the NYSE open.</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">Shows how the gap guard tightens the trigger and target in the window before the NYSE open, and what rebalance() would do then.</p>
      )}
    </Card>
  );
}

function initialSim(price: number): sim.SimState {
  const V = 1_000_000;
  const E = V / 2;
  return {
    C: V / price,
    U: 0,
    S: V - E,
    X: E,
    P: price,
    anchor: price,
    spDeposits: 120_000,
    vaultBufferUsd: 25_000,
    params: { ...sim.DEFAULT_SIM_PARAMS },
    marketOpen: true,
    gapGuard: false,
    priceUpdatedAt: Math.floor(Date.now() / 1000),
    snapshotId: 1,
    riskSource: "RULE",
  };
}

function OfflineScenario() {
  const prices = useDemoPrices();
  const ref = prices.data?.prices.NVDA?.price ?? REFERENCE_FALLBACK.NVDA;
  const [s, setS] = useState<sim.SimState | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const state = s ?? initialSim(ref);
  const snap = sim.toSnapshot(state);
  const push = (l: string) => setLog((x) => [l, ...x].slice(0, 12));
  const [steps, setSteps] = useState<sim.WaterfallStep[] | null>(null);

  const doShock = (bps: number) => {
    try {
      let next = sim.shock(state, bps);
      push(`Shock ${bps / 100}% → price ${fmtUsd(next.P)}`);
      const d = sim.derive(next);
      if (bps <= -2200 && d.E > 0) push("Mint check: BreakerTripped(devBps > maxDevBps) — feed is far from the CMC reference.");
      if (bps <= -5000) {
        const w = sim.waterfall(next);
        next = w.state;
        setSteps(w.steps);
        push(`Loss waterfall ran: sUSD pays ${fmtUsd(w.payoutPerSusd, { digits: 4 })} per sUSD.`);
      } else {
        const r = sim.previewRebalance(next);
        next = r.state;
        setSteps(null);
        push(r.note);
      }
      setS(next);
    } catch (e) {
      push(e instanceof sim.SimError ? `Reverted: ${e.message}` : String(e));
    }
  };

  return (
    <div className="space-y-5">
      <Card title="Offline simulation (NVDA, local only)" right={<span className="text-xs text-muted">anchor {fmtUsd(state.anchor)}</span>}>
        <div className="grid gap-3 sm:grid-cols-3">
          {SHOCKS.map((x) => (
            <button key={x.bps} className="btn flex-col items-start text-left" onClick={() => doShock(x.bps)}>
              <span className={`num text-base font-semibold ${x.bps < 0 ? "text-bad" : "text-good"}`}>{x.label}</span>
              <span className="text-xs font-normal text-muted">{x.hint}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="btn btn-sm"
            onClick={() => {
              const next = { ...state, marketOpen: false, gapGuard: true };
              const r = sim.previewRebalance(next);
              setS(r.state);
              push(`Skipped to pre-open: trigger ${fmtLev(sim.effective(next).trigger)}, target ${fmtLev(sim.effective(next).target)}. ${r.note}`);
            }}
          >
            Skip to pre-open
          </button>
          <button className="btn btn-sm" onClick={() => { const r = sim.previewRebalance(state); setS(r.state); push(r.note); }}>
            Run rebalance
          </button>
          <button className="btn btn-sm" onClick={() => { setS(null); setSteps(null); setLog([]); }}>
            Reset
          </button>
        </div>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2">Pool <ModePill mode={snap.mode} /></span>}>
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Price" value={fmtUsd(snap.price)} />
            <Stat label="Leverage" value={fmtLev(snap.leverage)} tone="lever" />
            <Stat label="CR" value={Number.isFinite(snap.cr) ? fmtPct(snap.cr, 0) : "∞"} tone="stable" />
          </div>
          <div className="mt-5 space-y-5">
            <LeverageGauge snap={snap} />
            <CrGauge snap={snap} />
            <SplitBar snap={snap} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-6">
            <KV k="Stability Pool" v={fmtUsd(state.spDeposits, { compact: true })} />
            <KV k="Vault buffer" v={fmtUsd(state.vaultBufferUsd, { compact: true })} />
          </div>
        </Card>
        <Card title="Event log">
          {steps && (
            <ol className="mb-4 space-y-2">
              {steps.map((st, i) => (
                <li key={i} className={`rounded-lg border px-3 py-2 text-xs ${st.done ? "border-warn/50 bg-warn/5" : "border-line"}`}>
                  <div className="flex justify-between font-medium text-ink">
                    <span>{i + 1}. {st.step}</span>
                    <span className="num">CR {Number.isFinite(st.crAfter) ? fmtPct(st.crAfter, 0) : "∞"}</span>
                  </div>
                  <div className="mt-0.5 text-muted">{st.detail}</div>
                </li>
              ))}
            </ol>
          )}
          {log.length === 0 ? <p className="text-sm text-muted">Pick a shock to start.</p> : (
            <ul className="space-y-1.5 font-mono text-xs text-muted">
              {log.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
