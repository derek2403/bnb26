"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatEther, parseAbi, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { OpenFourCoreAbi, SandboxFactoryAbi, SplitLauncherAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { useTx } from "@/hooks/useTx";
import { addressUrl, tokenUrl, txUrl } from "@/config/chains";
import { STOCK_NAMES } from "@/config/demoPools";
import { FLAP, useFlapFactoryInfo, useFlapLaunch, useMyLaunches, type LaunchStep, type MyLaunch } from "@/hooks/useFlapLaunch";
import { LAUNCH_BOUNDS, byteLen, flapLauncherUrl } from "@/lib/flapLaunch";
import { fmtNum, short } from "@/lib/format";
import { TickerIcon } from "../ui";

const STOCKS = ["NVDA", "TSLA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "AVGO", "NFLX", "COIN", "MSTR", "AMD"] as const;
const LIVE = "NVDA"; // the Flap launcher factory's stock is fixed (immutable config)

type Venue = "more" | "flap" | "four";
// Where the new market is listed. A tick list: one or more can be chosen.
const VENUES: { id: Venue; name: string; logo?: string; note: string }[] = [
  { id: "more", name: "MORE", logo: "/logos/more.png", note: "This platform" },
  { id: "flap", name: "Flap", logo: "/partners/flap.png", note: "Token launch on Flap" },
  { id: "four", name: "Four.meme", logo: "/partners/fourmeme.png", note: "Token launch on OpenFour" },
];
// MORE only: SandboxFactory.create() opens a pool on MORE's own PoolFactory from the user's wallet.
// Each stock has its own factory. One wallet can open one market for each stock.
const DIRECT: Record<string, Address | undefined> = {
  NVDA: addr(deployments97.core.sandboxFactory),
  AAPL: addr(deployments97.core.sandboxFactoryAAPL),
  TSLA: addr(deployments97.core.sandboxFactoryTSLA),
};
const tradeHref = (stock: string) => (stock === "NVDA" ? "/trade/sandbox" : `/trade/${stock.toLowerCase()}`);
type StepState = "wait" | "run" | "done" | "skip" | "error";
const LEV_MIN = 1.5;
const LEV_MAX = 3;
const LEV_GAP = 0.3; // smallest allowed distance between the two ends of the range
const THUMB =
  "pointer-events-none absolute inset-0 h-5 w-full cursor-pointer appearance-none bg-transparent " +
  "[&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:bg-transparent " +
  "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none " +
  "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-[rgb(var(--lever))] " +
  "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full " +
  "[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-[rgb(var(--lever))]";

const fmtBnb = (wei: bigint | undefined, d = 3) => (wei === undefined ? "…" : fmtNum(Number(formatEther(wei)), d));

function parseBnb(s: string): bigint | undefined {
  try {
    const t = s.trim();
    if (!t || !/^\d*\.?\d*$/.test(t)) return undefined;
    return parseEther(t as `${number}`);
  } catch {
    return undefined;
  }
}

const STEP_TEXT: Record<LaunchStep, string> = {
  idle: "",
  mining: "Finding a 7777 address…",
  checking: "Checking the address on-chain…",
  register: "Confirm 1 of 2 in your wallet: register the market launcher",
  launch: "Confirm in your wallet: send the launch to Flap",
  done: "Launch created on Flap.",
  error: "",
};

export function LaunchMarketForm() {
  const { list, add } = useMyLaunches();
  const info = useFlapFactoryInfo();
  const flow = useFlapLaunch(add);
  const { openConnectModal } = useConnectModal();

  const [stock, setStock] = useState<string>(LIVE);
  const DIRECT_FACTORY = DIRECT[stock];
  const [venues, setVenues] = useState<Venue[]>(["more"]);
  const toggleVenue = (v: Venue) => setVenues((cur) => (cur.includes(v) ? (cur.length > 1 ? cur.filter((x) => x !== v) : cur) : [...cur, v]));
  const [levLo, setLevLo] = useState(1.6);
  const [levHi, setLevHi] = useState(2.7);
  // The launcher contract stores one requested leverage, so the middle of the range is sent.
  const lev = Math.round(((levLo + levHi) / 2) * 10) / 10;
  const pct = (x: number) => ((x - LEV_MIN) / (LEV_MAX - LEV_MIN)) * 100;

  // Which contracts the button calls, from the ticks: MORE -> our own factory, Flap -> the Flap launch.
  const wantMore = venues.includes("more");
  const wantFlap = venues.includes("flap");
  const wantFour = venues.includes("four");
  const { address: me } = useAccount();
  const tx = useTx();
  const mine = useReadContract({
    address: DIRECT_FACTORY,
    abi: SandboxFactoryAbi,
    functionName: "sandboxOf",
    args: me ? [me] : undefined,
    chainId: bscTestnet.id,
    query: { enabled: !!DIRECT_FACTORY && !!me, refetchInterval: 15_000 },
  });
  const myPool = (mine.data as { pool?: Address } | undefined)?.pool;
  const hasDirect = !!myPool && myPool !== zeroAddress;
  const [direct, setDirect] = useState<{ ok: boolean; text: string } | null>(null);
  // Progress pop-up: which launches this press started, and the state of the MORE and Four.meme ones.
  const [run, setRun] = useState<{ more: boolean; flap: boolean; four: boolean } | null>(null);
  const [moreState, setMoreState] = useState<StepState>("wait");
  const [fourState, setFourState] = useState<StepState>("wait");
  const [directBusy, setDirectBusy] = useState(false);
  const openDirect = async () => {
    if (!DIRECT_FACTORY) return false;
    setDirectBusy(true);
    setDirect(null);
    setMoreState("run");
    // A stock that the keeper does not serve needs a fresh reference price first, or the pool cannot mint sUSD.
    if (stock === "AAPL") {
      const ok = await fetch("/api/launch/ref-price", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: stock }) })
        .then((x) => x.json() as Promise<{ ok: boolean; error?: string }>)
        .catch(() => ({ ok: false, error: "The price service did not answer." }));
      if (!ok.ok) {
        setDirectBusy(false);
        setMoreState("error");
        setDirect({ ok: false, text: ok.error ?? "The reference price was not posted." });
        return false;
      }
    }
    const r = await tx.send({ address: DIRECT_FACTORY, abi: SandboxFactoryAbi, functionName: "create", args: [], label: "Open the market on MORE" } as never);
    setDirectBusy(false);
    void mine.refetch();
    const ok = !!r && (r as { status?: string }).status === "success";
    setMoreState(ok ? "done" : "error");
    setDirect(ok ? { ok: true, text: "Market opened on MORE, directly on our pool factory." } : { ok: false, text: "The market was not opened on MORE." });
    return ok;
  };

  // Four.meme: the server's operator key (the same key that funds a Flap launch) buys the rest of the TSLA Market
  // launch on OpenFour. That sells it out, and graduation opens the TSLA market. No wallet confirm.
  const [four, setFour] = useState<{ ok: boolean; text: string } | null>(null);
  const [fourBusy, setFourBusy] = useState(false);
  const [fourPool, setFourPool] = useState<Address | null>(null);
  const launchFour = async () => {
    setFourBusy(true);
    setFour(null);
    setFourState("run");
    try {
      const res = await fetch("/api/launch/create-four", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = (await res.json()) as { ok: boolean; error?: string; steps?: string[]; name?: string; pool?: Address | null; token?: Address };
      setFourPool(j.ok ? (j.pool ?? null) : null);
      setFour(j.ok ? { ok: true, text: `${j.name ?? "The launch"} was created, sold out and graduated. Its TSLA market is open.` } : { ok: false, text: `${j.steps?.length ? `Done: ${j.steps.join("; ")}. Then: ` : ""}${j.error ?? "The launch failed."}` });
      setFourState(j.ok ? "done" : "error");
    } catch {
      setFour({ ok: false, text: "The launch failed. Try again." });
      setFourState("error");
    } finally {
      setFourBusy(false);
    }
  };

  // What the creator puts in, and how it is split between the two tokens (shown in the plan; see the note in the form).
  const [deposit, setDeposit] = useState("2");
  const [levShare, setLevShare] = useState(50); // percent of the deposit that becomes the leveraged token
  const [aliceRate, setAliceRate] = useState("4");
  const [bobRate, setBobRate] = useState("3.6");
  const depNum = Number(deposit);
  const depOk = Number.isFinite(depNum) && depNum > 0;
  const levPart = depOk ? (depNum * levShare) / 100 : 0;
  const stablePart = depOk ? depNum - levPart : 0;
  const startLev = 100 / levShare;

  // "Modify" on a market card (see LaunchpadView) selects that stock here and scrolls to this form.
  const [editing, setEditing] = useState<string | null>(null);
  const formRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const st = (e as CustomEvent<{ stock?: string }>).detail?.stock;
      if (!st) return;
      setStock(st);
      setEditing(st);
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("more:edit-market", on);
    return () => window.removeEventListener("more:edit-market", on);
  }, []);
  const [raise, setRaise] = useState("4.7");
  const [seed, setSeed] = useState("0.2");
  const [days, setDays] = useState("3");
  const [advanced, setAdvanced] = useState(false);

  const target = parseBnb(raise);
  const seedWei = parseBnb(seed);
  const daysNum = Number(days);
  const durationSec = Number.isFinite(daysNum) ? Math.round(daysNum * 86400) : NaN;
  const quote = target !== undefined && seedWei !== undefined && target >= seedWei ? target - seedWei : undefined;
  const minQuote = info.minPoolQuote;
  const minTarget = minQuote !== undefined && seedWei !== undefined ? minQuote + seedWei : undefined;
  const name = `${stock} Market`;
  const symbol = `${stock}M`;

  let problem: string | null = null;
  if (stock !== LIVE) problem = "This stock cannot be launched on testnet yet.";
  else if (target === undefined) problem = "Enter a raise in tBNB.";
  else if (seedWei === undefined) problem = "Enter a seed in tBNB.";
  else if (target < LAUNCH_BOUNDS.minTarget || target > LAUNCH_BOUNDS.maxTarget) problem = "The raise must be between 0.5 and 1,000 tBNB.";
  else if (seedWei < LAUNCH_BOUNDS.minSeed || seedWei * 2n > target) problem = "The seed must be at least 0.01 tBNB and at most half the raise.";
  else if (!Number.isFinite(durationSec) || durationSec < LAUNCH_BOUNDS.minDuration || durationSec > LAUNCH_BOUNDS.maxDuration) problem = "The raise window must be between 10 minutes and 30 days.";
  else if (minQuote !== undefined && quote !== undefined && quote < minQuote) problem = `The raise is below Flap's minimum: at least ${fmtBnb(minTarget)} tBNB with a ${fmtBnb(seedWei, 2)} tBNB seed.`;
  else if (byteLen(name) > LAUNCH_BOUNDS.maxName || byteLen(symbol) > LAUNCH_BOUNDS.maxSymbol) problem = "Name or symbol too long.";
  if (!FLAP.factory || !FLAP.portal) problem = "The Flap launcher is not deployed on this network.";

  const flapInput = () => ({ stock, targetLeverage: lev, targetRaise: target as bigint, backstopSeed: seedWei as bigint, saleDurationSec: durationSec });
  const submit = async () => {
    if ((wantMore || wantFlap) && !flow.isConnected) {
      openConnectModal?.();
      return;
    }
    setRun({ more: wantMore, flap: wantFlap && !problem, four: wantFour });
    setMoreState(wantMore && hasDirect ? "skip" : "wait");
    setFourState("wait");
    setFour(null);
    setDirect(null);
    // Four.meme needs no wallet: the server key signs it, so it runs beside the wallet steps.
    if (wantFour) void launchFour();
    // 1. MORE: straight to our own contract.
    if (wantMore && !hasDirect) {
      const ok = await openDirect();
      if (!ok) return;
    }
    // 2. Flap: the pre-funded launch (only when ticked).
    if (wantFlap && !problem && target !== undefined && seedWei !== undefined) void flow.start(flapInput());
  };
  const flapProblem = wantFlap ? problem : null;
  const directProblem = wantMore && !DIRECT_FACTORY ? "A direct market on MORE supports NVDA, TSLA and AAPL on testnet." : null;
  const fourProblem = wantFour && stock !== "TSLA" ? "Four.meme launches support TSLA on testnet." : null;
  const nothingToDo = !wantFlap && !wantFour && (!wantMore || hasDirect);
  const blocked = !!directProblem || !!flapProblem || !!fourProblem || nothingToDo;

  return (
    <section ref={formRef} id="open-market" className="mt-4 scroll-mt-20 rounded-card border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-[13px] font-semibold text-ink">{editing ? `Modify my market · ${editing}` : "Open a market"}</h2>
        <span className="pill">
          <span className="h-1.5 w-1.5 rounded-full bg-lever" />
          Pre-funded launch · BSC testnet
        </span>
      </div>

      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {/* 1. Where to launch */}
          <div>
            <div className="flex items-baseline justify-between">
              <span className="label">1 · Launch on</span>
              <span className="text-2xs text-faint">Tick one or more</span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {VENUES.map((v) => {
                const on = venues.includes(v.id);
                return (
                  <button
                    key={v.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggleVenue(v.id)}
                    disabled={flow.busy}
                    className={`flex h-12 min-w-0 items-center gap-3 rounded border px-3 text-left transition-colors ${on ? "border-accent bg-surface2" : "border-line hover:bg-surface2"}`}
                  >
                    <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border text-[12px] font-bold leading-none ${on ? "border-accent bg-accent text-white" : "border-line bg-surface text-transparent"}`} aria-hidden>
                      ✓
                    </span>
                    {v.id === "more" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <span className="flex h-6 shrink-0 items-center">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={v.logo} alt="MORE" className="h-[13px] w-auto dark:invert" />
                      </span>
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.logo} alt="" width={24} height={24} className="h-6 w-6 shrink-0 rounded-md bg-white object-contain" />
                    )}
                    {v.id !== "more" && <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{v.name}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Stock */}
          <div>
            <div className="label">2 · Stock</div>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {STOCKS.map((s) => {
                const on = s === stock;
                const live = !!DIRECT[s];
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStock(s)}
                    disabled={flow.busy}
                    className={`flex min-w-0 items-center gap-2 rounded border px-2 py-2 text-left transition-colors ${on ? "border-accent bg-surface2" : "border-line hover:bg-surface2"} ${live ? "" : "opacity-60"}`}
                  >
                    <TickerIcon sym={s} size={22} />
                    <span className="min-w-0">
                      <span className="num block text-xs font-semibold text-ink">{s}</span>
                      <span className="block truncate text-2xs text-faint">{live ? "Available" : s === "TSLA" ? "Four.meme" : "Soon"}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {stock === "TSLA" ? (
              <p className="mt-2 text-xs text-muted">Tesla, priced by the Atlas feed. The market pairs sUSD with leveraged xTSLA. It can launch on MORE and on Four.meme together.</p>
            ) : stock === "AAPL" ? (
              <p className="mt-2 text-xs text-muted">Apple, with a test token and a test price on testnet. The market pairs sUSD with leveraged xAAPL.</p>
            ) : stock !== LIVE ? (
              <p className="mt-2 text-xs text-muted">{STOCK_NAMES[stock] ?? stock}: needs a tokenized stock and price feed on testnet before it can be launched.</p>
            ) : (
              <p className="mt-2 text-xs text-muted">NVIDIA, priced by the Atlas feed. The market pairs sUSD with leveraged xNVDA.</p>
            )}
          </div>

          {/* 3. Leverage range */}
          <div>
            <div className="flex items-baseline justify-between">
              <span className="label">3 · Leverage range</span>
              <span className="num text-sm font-semibold text-lever">
                {levLo.toFixed(1)}x – {levHi.toFixed(1)}x
              </span>
            </div>
            <div className="relative mt-3 h-5">
              <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface2" />
              <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-lever" style={{ left: `${pct(levLo)}%`, right: `${100 - pct(levHi)}%` }} />
              <input
                type="range"
                min={LEV_MIN}
                max={LEV_MAX}
                step={0.1}
                value={levLo}
                onChange={(e) => setLevLo(Math.min(Number(e.target.value), Math.round((levHi - LEV_GAP) * 10) / 10))}
                disabled={flow.busy}
                className={THUMB}
                aria-label="Lowest leverage"
              />
              <input
                type="range"
                min={LEV_MIN}
                max={LEV_MAX}
                step={0.1}
                value={levHi}
                onChange={(e) => setLevHi(Math.max(Number(e.target.value), Math.round((levLo + LEV_GAP) * 10) / 10))}
                disabled={flow.busy}
                className={THUMB}
                aria-label="Highest leverage"
              />
            </div>
            <div className="num mt-1 flex justify-between text-2xs text-faint">
              <span>{LEV_MIN}x</span>
              <span>{LEV_MAX}x</span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              The pool buys stock back at the low end and sells stock at the high end. The launch records the middle of this range ({lev.toFixed(1)}x). On testnet the market opens with MORE&apos;s standard band (about 1.5x–2.2x) and its risk settings apply.
            </p>
          </div>

          {/* 4. Deposit and split */}
          <div>
            <div className="label">4 · Your deposit</div>
            <div className="mt-2 flex items-center gap-2">
              <input className="input max-w-[180px]" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} disabled={flow.busy} aria-label={`Deposit in t${stock}`} />
              <span className="text-xs text-muted">t{stock}</span>
            </div>
            <div className="mt-3 flex items-baseline justify-between text-xs">
              <span className="text-muted">How the deposit is split</span>
              <span className="num text-ink">
                starts at <span className="font-semibold text-lever">{startLev.toFixed(2)}x</span>
              </span>
            </div>
            <input
              type="range"
              min={34}
              max={66}
              step={1}
              value={levShare}
              onChange={(e) => setLevShare(Number(e.target.value))}
              disabled={flow.busy}
              className="mt-2 w-full accent-[rgb(var(--lever))]"
              aria-label="Share of the deposit that becomes the leveraged token"
            />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded border border-line bg-surface2 px-3 py-2">
                <div className="text-2xs text-faint">Leveraged · x{stock}</div>
                <div className="num text-sm font-semibold text-lever">
                  {fmtNum(levPart, 3)} t{stock} <span className="text-2xs font-normal text-faint">{levShare}%</span>
                </div>
              </div>
              <div className="rounded border border-line bg-surface2 px-3 py-2">
                <div className="text-2xs text-faint">Stable · sUSD</div>
                <div className="num text-sm font-semibold text-stable">
                  {fmtNum(stablePart, 3)} t{stock} <span className="text-2xs font-normal text-faint">{100 - levShare}%</span>
                </div>
              </div>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">Leverage at the start is the whole deposit divided by the leveraged part. A smaller leveraged part gives a higher leverage.</p>
          </div>

          {/* 5. Rates */}
          <div>
            <div className="label">5 · Rates</div>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-2xs text-faint">Funding fee · leveraged holders pay (% a year)</span>
                <span className="mt-1 flex items-center gap-2">
                  <input className="input" inputMode="decimal" value={aliceRate} onChange={(e) => setAliceRate(e.target.value)} disabled={flow.busy} />
                  <span className="text-xs text-muted">%</span>
                </span>
              </label>
              <label className="block">
                <span className="text-2xs text-faint">Lending rate · stable holders earn (% a year)</span>
                <span className="mt-1 flex items-center gap-2">
                  <input className="input" inputMode="decimal" value={bobRate} onChange={(e) => setBobRate(e.target.value)} disabled={flow.busy} />
                  <span className="text-xs text-muted">%</span>
                </span>
              </label>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">The difference between the two rates is the share for the creator and the platform. On testnet the funding fee is fixed at 4% a year.</p>
          </div>

          {/* Launch settings that the testnet launcher needs */}
          <div>
            <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => setAdvanced((v) => !v)}>
              {advanced ? "Hide" : "Show"} launch settings (testnet)
            </button>
            {advanced && (
              <>
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-2xs text-faint">Launch raise (tBNB)</span>
                    <input className="input mt-1" inputMode="decimal" value={raise} onChange={(e) => setRaise(e.target.value)} disabled={flow.busy} aria-label="Raise in tBNB" />
                  </label>
                  <label className="block">
                    <span className="text-2xs text-faint">Seed for the market (tBNB)</span>
                    <input className="input mt-1" inputMode="decimal" value={seed} onChange={(e) => setSeed(e.target.value)} disabled={flow.busy} />
                  </label>
                  <label className="block">
                    <span className="text-2xs text-faint">Raise window (days)</span>
                    <input className="input mt-1" inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} disabled={flow.busy} />
                  </label>
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  On testnet a market opens through a pre-funded launch. Minimum raise <span className="num text-ink">{fmtBnb(minTarget)}</span> tBNB with a {fmtBnb(seedWei, 2)} tBNB seed. You pay only the {fmtBnb(info.lockFee)} tBNB lock fee and gas.
                </p>
              </>
            )}
          </div>
        </div>

        {/* Summary + action */}
        <div className="self-start rounded-card border border-line bg-surface2 p-3">
          <div className="flex items-center gap-2">
            <TickerIcon sym={stock} size={28} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-ink">{name}</div>
              <div className="num text-2xs text-faint">${symbol}</div>
            </div>
          </div>
          <dl className="mt-3 space-y-1.5 text-xs">
            <Row k="Market" v={`sUSD + x${stock}`} />
            <Row k="Leverage range" v={`${levLo.toFixed(1)}x – ${levHi.toFixed(1)}x`} />
            <Row k="Deposit" v={depOk ? `${fmtNum(depNum, 3)} t${stock}` : "–"} />
            <Row k="Leveraged / stable" v={`${levShare}% / ${100 - levShare}%`} />
            <Row k="Starting leverage" v={`${startLev.toFixed(2)}x`} />
            <Row k="Funding fee" v={`${aliceRate || "–"}% a year`} />
            <Row k="Lending rate" v={`${bobRate || "–"}% a year`} />
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted">Contract</dt>
              <dd className="flex items-center gap-1.5">
                {VENUES.filter((v) => venues.includes(v.id)).map((v) => (
                  <span key={v.id} className="inline-flex h-6 w-[52px] items-center justify-center rounded border border-line bg-surface" title={v.id === "more" ? "MORE pool factory" : v.id === "flap" ? "Flap portal" : "OpenFour"}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={v.logo} alt={v.name} className={v.id === "more" ? "h-[9px] w-auto dark:invert" : "h-4 w-4 rounded-[3px] object-contain"} />
                  </span>
                ))}
              </dd>
            </div>
          </dl>
          <button type="button" className="btn-primary mt-3 w-full" disabled={blocked || flow.busy || directBusy || fourBusy} onClick={() => void submit()}>
            {directBusy ? "Confirm in your wallet…" : fourBusy && !flow.busy ? "Sending to Four.meme…" : flow.busy ? (flow.step === "mining" ? "Finding a 7777 address…" : "Confirm in your wallet…") : editing ? "Save and relaunch the market" : "Launch the market"}
          </button>
          {directProblem && <p className="mt-2 text-xs text-warn">{directProblem}</p>}
          {flapProblem && <p className="mt-2 text-xs text-warn">{flapProblem}</p>}
          {fourProblem && <p className="mt-2 text-xs text-warn">{fourProblem}</p>}
          {wantMore && hasDirect && (
            <p className="mt-2 text-xs text-muted">
              This wallet already has a {stock} market on MORE:{" "}
              <a className="num link" href={addressUrl(myPool!)} target="_blank" rel="noreferrer">
                {short(myPool!, 6)}
              </a>
              .{" "}
              <Link href={tradeHref(stock)} className="link">
                Trade it
              </Link>
            </p>
          )}
          {!blocked && !flow.isConnected && flow.step === "idle" && <p className="mt-2 text-xs text-muted">You will be asked to connect a wallet first.</p>}
          {flow.step !== "idle" && flow.step !== "error" && (
            <p className={`mt-2 text-xs ${flow.step === "done" ? "text-good" : "text-muted"}`}>
              {STEP_TEXT[flow.step]}
              {flow.step === "mining" && <span className="num text-faint"> {flow.tries.toLocaleString()} tried</span>}
            </p>
          )}
          {flow.step === "error" && flow.error && <p className="mt-2 break-words text-xs text-bad">{flow.error}</p>}
{wantFlap && (
            <p className="mt-2 text-2xs leading-relaxed text-faint">
              Flap: when the raise fills, the token launches on Flap and the seed opens the new {stock} market on MORE. If the raise misses its window, contributors get full refunds.
            </p>
          )}
        </div>
      </div>

      {run && (
        <LaunchProgress
          run={run}
          stock={stock}
          more={{ state: moreState, text: moreState === "skip" ? "This wallet already has a market on MORE." : moreState === "run" ? "Confirm in your wallet…" : direct?.text }}
          flap={{
            state: flow.step === "done" ? "done" : flow.step === "error" ? "error" : flow.step === "idle" ? "wait" : "run",
            text: flow.step === "error" ? flow.error ?? "The launch failed." : flow.step === "mining" ? `${STEP_TEXT.mining} ${flow.tries.toLocaleString()} tried` : STEP_TEXT[flow.step],
          }}
          four={{ state: fourState, text: fourState === "run" ? "Creating the launch, funding it and graduating it (about a minute)…" : four?.text }}
          fourPool={fourPool ?? undefined}
          pool={hasDirect ? myPool : undefined}
          onClose={() => setRun(null)}
        />
      )}

      {list.length > 0 && (
        <div className="border-t border-line p-4">
          <div className="label">Your launches</div>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {list.map((l) => (
              l.venue === "four" ? <FourLaunchCard key={l.launcher} l={l} onPool={(pool) => add({ ...l, pool })} /> : <LaunchCard key={l.launcher} l={l} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted">{k}</dt>
      <dd className="num text-ink">{v}</dd>
    </div>
  );
}

function LaunchCard({ l }: { l: MyLaunch }) {
  const fn = ["raised", "targetRaise", "saleDeadline", "launched", "failed", "token", "pool"] as const;
  const r = useReadContracts({
    allowFailure: true,
    query: { refetchInterval: 15_000 },
    contracts: fn.map((functionName) => ({ address: l.launcher, abi: SplitLauncherAbi, functionName, chainId: bscTestnet.id })),
  });
  const v = <T,>(i: number) => (r.data?.[i]?.status === "success" ? (r.data[i].result as T) : undefined);
  const raised = v<bigint>(0);
  const target = v<bigint>(1) ?? BigInt(l.targetRaise);
  const deadline = v<bigint>(2);
  const launched = v<boolean>(3);
  const failed = v<boolean>(4);
  const liveToken = v<Address>(5);
  const pool = v<Address>(6);
  const token = liveToken && liveToken !== zeroAddress ? liveToken : l.token;
  const pct = raised !== undefined && target > 0n ? Math.min(100, Number((raised * 10000n) / target) / 100) : 0;
  const open = !!pool && pool !== zeroAddress;
  const [funding, setFunding] = useState(false);
  const [fundMsg, setFundMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Demo funding: a server-side testnet key fills the rest of the raise and opens the market (no wallet popup).
  const fund = async () => {
    setFunding(true);
    setFundMsg(null);
    try {
      const res = await fetch("/api/launch/fund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launcher: l.launcher }) });
      const j = (await res.json()) as { ok: boolean; error?: string; steps?: string[] };
      setFundMsg(j.ok ? { ok: true, text: j.steps?.length ? `Done: ${j.steps.join("; ")}.` : "The market is open." } : { ok: false, text: j.error ?? "Funding failed." });
    } catch {
      setFundMsg({ ok: false, text: "Funding failed. Try again." });
    } finally {
      setFunding(false);
      void r.refetch();
    }
  };
  const status = pool && pool !== zeroAddress ? "Market open" : launched ? "Raise filled" : failed ? "Refunding" : raised === undefined ? "…" : "Pre-funding";

  return (
    <div className="min-w-0 rounded-card border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TickerIcon sym={l.stock} size={24} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-ink">{l.name}</div>
            <div className="num text-2xs text-faint">
              ${l.symbol} · wants {l.targetLeverage.toFixed(1)}x
            </div>
          </div>
        </div>
        <span className={`pill ${status === "Market open" || status === "Raise filled" ? "border-good/40 text-good" : failed ? "border-bad/40 text-bad" : ""}`}>{status}</span>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-sm bg-surface2">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div className="num mt-1 flex justify-between text-2xs text-faint">
        <span>
          {fmtBnb(raised)} / {fmtBnb(target)} tBNB · {pct.toFixed(0)}%
        </span>
        {deadline !== undefined && <span>ends {new Date(Number(deadline) * 1000).toLocaleDateString()}</span>}
      </div>
      <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs">
        <span className="text-faint">Launcher</span>
        <a className="num link truncate" href={addressUrl(l.launcher)} target="_blank" rel="noreferrer" title={l.launcher}>
          {short(l.launcher, 6)}
        </a>
        <span className="text-faint">Token</span>
        <a className="num link truncate" href={tokenUrl(token)} target="_blank" rel="noreferrer" title={token}>
          {short(token, 6)}
        </a>
        {l.tx && (
          <>
            <span className="text-faint">Tx</span>
            <a className="num link truncate" href={txUrl(l.tx)} target="_blank" rel="noreferrer">
              {short(l.tx, 6)}
            </a>
          </>
        )}
      </div>
      {fundMsg && <p className={`mt-2 text-2xs ${fundMsg.ok ? "text-good" : "text-bad"}`}>{fundMsg.text}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {open ? (
          <Link href={`/trade/${l.stock.toLowerCase()}-${pool!.slice(2, 8).toLowerCase()}`} className="btn-primary btn-sm w-full">
            Trade this market
          </Link>
        ) : (
          <button className="btn-primary btn-sm w-full" disabled={funding || failed === true || raised === undefined} onClick={fund}>
            {funding ? "Funding and opening (about a minute)…" : launched ? "Open the market" : "Fund and open the market"}
          </button>
        )}
        <a href={flapLauncherUrl(l.launcher)} target="_blank" rel="noreferrer" className="btn btn-sm w-full">
          View on Flap
        </a>
      </div>
    </div>
  );
}

const fourVaultAbi = parseAbi(["function totalRaised() view returns (uint256)", "function remainingForSale() view returns (uint256)"]);
const fourMigrateAbi = parseAbi([
  "function lastGraduation() view returns ((uint8 branch, address pair, address pool, address sUSD, address xToken, address stabilityPool, uint256 quoteUsed, uint256 tokenUsed, uint256 seedAmount, uint256 mintAmount) g)",
]);
const FOUR_CORE = addr(deployments97.openfour.core);

/** A TSLA Market launch on Four.meme (OpenFour). Pre-funding until it sells out; graduation opens the TSLA market. */
function FourLaunchCard({ l, onPool }: { l: MyLaunch; onPool: (pool: Address) => void }) {
  const core = useReadContract({ address: FOUR_CORE, abi: OpenFourCoreAbi, functionName: "tokens", args: [l.launcher], chainId: bscTestnet.id, query: { enabled: !!FOUR_CORE, staleTime: 600_000 } });
  const t = core.data as readonly unknown[] | undefined;
  const vault = t?.[10] as Address | undefined;
  const migrate = t?.[13] as Address | undefined;
  const target = (t?.[8] as bigint | undefined) ?? BigInt(l.targetRaise);
  const r = useReadContracts({
    allowFailure: true,
    query: { enabled: !!vault && !!migrate, refetchInterval: 10_000 },
    contracts: [
      { address: vault!, abi: fourVaultAbi, functionName: "totalRaised", chainId: bscTestnet.id },
      { address: migrate!, abi: fourMigrateAbi, functionName: "lastGraduation", chainId: bscTestnet.id },
    ],
  });
  const raised = r.data?.[0]?.status === "success" ? (r.data[0].result as bigint) : undefined;
  const grad = r.data?.[1]?.status === "success" ? (r.data[1].result as { pool: Address }) : undefined;
  const pool = grad && grad.pool !== zeroAddress ? grad.pool : l.pool;
  useEffect(() => {
    if (pool && pool !== l.pool) onPool(pool);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool]);
  const pct = raised !== undefined && target > 0n ? Math.min(100, Number((raised * 10000n) / target) / 100) : 0;
  const [funding, setFunding] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Demo funding: a server-side testnet key buys the rest of the sale, which graduates it (no wallet popup).
  const fund = async () => {
    setFunding(true);
    setMsg(null);
    try {
      const res = await fetch("/api/launch/fund-four", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: l.launcher }) });
      const j = (await res.json()) as { ok: boolean; error?: string; steps?: string[]; pool?: Address };
      if (j.ok && j.pool) onPool(j.pool);
      setMsg(j.ok ? { ok: true, text: j.steps?.length ? `Done: ${j.steps.join("; ")}.` : "The market is open." } : { ok: false, text: j.error ?? "Funding failed." });
    } catch {
      setMsg({ ok: false, text: "Funding failed. Try again." });
    } finally {
      setFunding(false);
      void r.refetch();
    }
  };
  const status = pool ? "Market open" : raised === undefined ? "…" : "Pre-funding";
  return (
    <div className="min-w-0 rounded-card border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TickerIcon sym={l.stock} size={24} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-ink">{l.name}</div>
            <div className="num text-2xs text-faint">
              ${l.symbol} · wants {l.targetLeverage.toFixed(1)}x · Four.meme
            </div>
          </div>
        </div>
        <span className={`pill ${pool ? "border-good/40 text-good" : ""}`}>{status}</span>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-sm bg-surface2">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div className="num mt-1 text-2xs text-faint">
        {fmtBnb(raised)} / {fmtBnb(target)} tTSLA · {pct.toFixed(0)}%
      </div>
      <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs">
        <span className="text-faint">Token</span>
        <a className="num link truncate" href={tokenUrl(l.launcher)} target="_blank" rel="noreferrer" title={l.launcher}>
          {short(l.launcher, 6)}
        </a>
        {l.tx && (
          <>
            <span className="text-faint">Tx</span>
            <a className="num link truncate" href={txUrl(l.tx)} target="_blank" rel="noreferrer">
              {short(l.tx, 6)}
            </a>
          </>
        )}
      </div>
      {msg && <p className={`mt-2 text-2xs ${msg.ok ? "text-good" : "text-bad"}`}>{msg.text}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {pool ? (
          <Link href={`/trade/${l.stock.toLowerCase()}-${pool.slice(2, 8).toLowerCase()}`} className="btn-primary btn-sm w-full">
            Trade this market
          </Link>
        ) : (
          <button className="btn-primary btn-sm w-full" disabled={funding || raised === undefined} onClick={fund}>
            {funding ? "Funding and opening (about a minute)…" : "Fund and open the market"}
          </button>
        )}
        <a href={tokenUrl(l.launcher)} target="_blank" rel="noreferrer" className="btn btn-sm w-full">
          View the launch token
        </a>
      </div>
    </div>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "run") return <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="In progress" />;
  if (state === "done" || state === "skip") return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-good text-[12px] font-bold leading-none text-white">✓</span>;
  if (state === "error") return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bad text-[12px] font-bold leading-none text-white">✕</span>;
  return <span className="h-5 w-5 shrink-0 rounded-full border-2 border-line" aria-label="Waiting" />;
}

/** Pop-up that shows each ticked launch with a spinner while it runs and a tick when it is done. */
function LaunchProgress({
  run,
  stock,
  more,
  flap,
  four,
  pool,
  fourPool,
  onClose,
}: {
  run: { more: boolean; flap: boolean; four: boolean };
  stock: string;
  more: { state: StepState; text?: string };
  flap: { state: StepState; text?: string };
  four: { state: StepState; text?: string };
  pool?: Address;
  fourPool?: Address;
  onClose: () => void;
}) {
  const rows = [
    run.more && { key: "more", logo: "/logos/more.png", wide: true, title: `Open the ${stock} market on MORE`, ...more },
    run.flap && { key: "flap", logo: "/partners/flap.png", wide: false, title: `Launch the ${stock} market on Flap`, ...flap },
    run.four && { key: "four", logo: "/partners/fourmeme.png", wide: false, title: "Launch the TSLA market on Four.meme", ...four },
  ].filter(Boolean) as { key: string; logo: string; wide: boolean; title: string; state: StepState; text?: string }[];
  const busy = rows.some((r) => r.state === "run" || r.state === "wait");
  const failed = rows.some((r) => r.state === "error");
  const waitLabel: Record<StepState, string> = { wait: "Waiting", run: "In progress", done: "Done", skip: "Already open", error: "Failed" };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onClose}>
      <div className="w-full max-w-[440px] rounded-card border border-line bg-surface p-5 shadow-xl" role="dialog" aria-modal="true" aria-label="Launch progress" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[15px] font-semibold text-ink">{busy ? "Launching your market" : failed ? "Launch not complete" : "Your market is live"}</h3>
          <button type="button" className="text-lg leading-none text-muted hover:text-ink" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <ul className="mt-4 space-y-3">
          {rows.map((r) => (
            <li key={r.key} className="flex items-start gap-3 rounded border border-line bg-surface2 px-3 py-3">
              <span className="mt-0.5">
                <StepIcon state={r.state} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">{r.title}</span>
                  <span className="flex h-6 w-[52px] shrink-0 items-center justify-center rounded border border-line bg-surface">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.logo} alt="" className={r.wide ? "h-[9px] w-auto dark:invert" : "h-4 w-4 rounded-[3px] object-contain"} />
                  </span>
                </span>
                <span className={`mt-0.5 block break-words text-xs ${r.state === "error" ? "text-bad" : r.state === "done" || r.state === "skip" ? "text-good" : "text-muted"}`}>{r.text || waitLabel[r.state]}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-center justify-end gap-2">
          {fourPool && run.four && !busy && (
            <a href={addressUrl(fourPool)} target="_blank" rel="noreferrer" className="btn btn-sm">
              TSLA market on the explorer
            </a>
          )}
          {pool && run.more && !busy && stock !== "NVDA" && (
            <a href={addressUrl(pool)} target="_blank" rel="noreferrer" className="btn btn-sm">
              {stock} market on the explorer
            </a>
          )}
          {pool && run.more && !busy && (
            <Link href={tradeHref(stock)} className="btn-primary btn-sm">
              Trade my market
            </Link>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            {busy ? "Hide" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
