"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { erc20Abi, formatUnits, parseEventLogs, parseUnits, type Address, type Hex, type TransactionReceipt } from "viem";
import { bscTestnet } from "viem/chains";
import { useAccount, usePublicClient } from "wagmi";
import { LeveragePoolAbi } from "@/abi";
import { txUrl } from "@/config/chains";
import { usePool } from "@/hooks/usePools";
import { useMySandbox } from "@/hooks/useSandbox";
import { useSandboxBook } from "@/hooks/useSandboxBook";
import { describeError, useTx } from "@/hooks/useTx";
import type { Interval } from "@/lib/candles";
import { fmtLev, fmtNum, fmtPct, fmtUsd, toNum } from "@/lib/format";
import { CandleChart } from "../trade/CandleChart";
import { Addr, CrGauge, LeverageGauge, ModePill, SplitBar, TickerIcon } from "../ui";

const C = bscTestnet.id;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
const minOf = (v: bigint) => (v * 995n) / 1000n;

const ok = (r: TransactionReceipt | null): r is TransactionReceipt => !!r && r.status === "success";
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

type LogRow = { id: number; label: string; text: string; tone: "good" | "bad" | "warn" | "muted"; txs: Hex[] };
const toneCls = (t: LogRow["tone"]) => (t === "good" ? "text-good" : t === "bad" ? "text-bad" : t === "warn" ? "text-warn" : "text-muted");
const signed = (n: number, f: (n: number) => string) => (n > 0 ? "+" : n < 0 ? "−" : "") + f(Math.abs(n));
const usd = (n: number) => fmtUsd(n, { digits: 2 });
const pct = (n: number) => fmtPct(n, 1);

function Panel({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Big({ k, v, sub, tone }: { k: string; v: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-2xs text-faint">{k}</div>
      <div className={`num text-lg font-semibold leading-tight ${tone ?? "text-ink"}`}>{v}</div>
      {sub && <div className="num mt-0.5 text-2xs text-muted">{sub}</div>}
    </div>
  );
}

export function SandboxView() {
  const { address } = useAccount();
  // The sandbox belongs to a server-side testnet key (the "market operator"): it moves the price and holds the staked sUSD.
  const [op, setOp] = useState<{ enabled: boolean; operator: Address | null } | null>(null);
  useEffect(() => {
    fetch("/api/sandbox")
      .then((r) => r.json())
      .then(setOp)
      .catch(() => setOp({ enabled: false, operator: null }));
  }, []);
  const sb = useMySandbox(op?.operator ?? null);
  const d = usePool("sandbox", sb.meta);
  const s = d.snap;
  // The leverage of the pool now. A new long position gets this leverage.
  const levNow = s && Number.isFinite(s.leverage) ? fmtLev(s.leverage) : "2x";
  const u = d.user;
  const client = usePublicClient({ chainId: C });
  const { send, pending } = useTx();
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [side, setSide] = useState<"long" | "stable">("long");
  const [interval, setIntervalSel] = useState<Interval>("1h");
  const [log, setLog] = useState<LogRow[]>([]);
  const book = useSandboxBook(sb.pool, sb.meta?.addresses?.stabilityPool, address, sb.createdAt);
  const stakerBook = useSandboxBook(sb.pool, sb.meta?.addresses?.stabilityPool, sb.owner, sb.createdAt);
  const push = (r: Omit<LogRow, "id">) => setLog((x) => [{ ...r, id: Date.now() + Math.random() }, ...x].slice(0, 10));
  const refresh = useCallback(() => {
    d.refetch();
    sb.refetch();
  }, [d, sb]);
  const run = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    try {
      await fn();
    } catch (e) {
      push({ label: k, tone: "bad", txs: [], text: describeError(e) });
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const disabled = !!pending || !!busy;
  const pool = sb.pool;
  const a = sb.meta?.addresses;

  // ------------------------------------------------------------- position maths (all in USD)
  const P = s?.price ?? 0;
  const nav = s?.xNav ?? 0;
  const xBal = u ? Number(formatUnits(u.x, 18)) : 0;
  // Position from the pool's own Minted/Redeemed events: the first-loss seed xNVDA from create() is not counted.
  const posX = Math.max(0, Math.min(book.x, xBal));
  const share = book.x > 0 ? posX / book.x : 0;
  const cIn = book.cIn * share;
  const usdIn = book.usdIn * share;
  const entry = cIn > 0 ? usdIn / cIn : 0;
  const value = posX * nav;
  const pnl = value - usdIn;
  const pnlPct = usdIn > 0 ? pnl / usdIn : 0;
  const move = entry > 0 && P > 0 ? P / entry - 1 : 0;
  const hold = cIn * P;
  const holdPnl = hold - usdIn;
  const hasPos = posX > 1e-9 && usdIn > 0;
  const live = sb.anchor ?? 0;
  const vsLive = live > 0 && P > 0 ? P / live - 1 : 0;

  // sUSD owners: the operator wallet staked all the sandbox's sUSD in the insurance pool.
  const sp = sb.ownerStake;
  const spS = sp?.deposit ?? 0;
  const spA = sp?.assetGain ?? 0;
  const spR = sp?.stableReward ?? 0;
  const sUSDPrice = s ? Math.min(1, Number.isFinite(s.cr) ? s.cr : 1) : 1;
  const stakersValue = spS * sUSDPrice + spA * P + spR;
  const stakedStart = stakerBook.staked > 0 ? stakerBook.staked : spS;
  const stakersPnl = stakersValue - stakedStart;
  // Who owns the pool: sUSD owners have a fixed dollar claim, xNVDA holders own the rest; the user's slice of that.
  const myShare = s && s.X > 0 ? posX / s.X : 0;

  // ------------------------------------------------------------- actions
  // A leverage above 100x means that the leveraged side is at or near zero.
  const big = (x: number) => (x > 100 ? "above 100x" : fmtLev(x));
  type Api = { ok: boolean; error?: string; txs?: Hex[]; steps?: string[]; price?: number; rebalances?: number; priceSteps?: number; zone?: { kind: "sell" | "buy"; levBefore?: number; levAfter?: number; sold?: number; out?: number; toStakers?: boolean } };
  const api = async (body: Record<string, unknown>): Promise<Api> => {
    const r = await fetch("/api/sandbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as Api;
  };

  const setup = () =>
    run("setup", async () => {
      const r = await api({ action: "setup" });
      if (!r.ok) return push({ label: "Set up", tone: "bad", txs: r.txs ?? [], text: r.error ?? "Setup failed." });
      push({ label: "Set up", tone: "good", txs: r.txs ?? [], text: r.steps?.length ? `The market operator ${r.steps.join(", ")}.` : "The sandbox is ready." });
    });

  const approve = async (token: Address, spender: Address, amt: bigint, label: string) => {
    const cur = (await client!.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address!, spender] })) as bigint;
    if (cur >= amt) return true;
    return ok(await send({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amt], label }));
  };

  const goLong = () =>
    run("long", async () => {
      if (!pool || !a?.asset) return;
      let amt: bigint;
      try {
        amt = parseUnits(amount || "0", d.decimals.asset);
      } catch {
        return;
      }
      if (amt <= 0n) return;
      let out: bigint;
      try {
        [out] = (await client!.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewMintLever", args: [amt] })) as readonly [bigint, bigint];
      } catch (e) {
        return push({ label: "Long 2x", tone: "bad", txs: [], text: `The pool won't open a position right now: ${describeError(e)}` });
      }
      if (!(await approve(a.asset, pool, amt, "Approve NVDA"))) return;
      const r = await send({ address: pool, abi: LeveragePoolAbi, functionName: "mintLever", args: [amt, minOf(out), deadline()], label: "Long 2x" });
      if (!ok(r)) return;
      book.addReceipt(r);
      const ev = parseEventLogs({ abi: LeveragePoolAbi, logs: r.logs, eventName: "Minted", strict: false }).find((e) => e.address.toLowerCase() === pool.toLowerCase());
      const xOut = ev?.args.out !== undefined ? toNum(ev.args.out) : toNum(out);
      const price = ev?.args.price !== undefined ? toNum(ev.args.price) : P;
      const c = toNum(amt, d.decimals.asset);
      push({ label: "Long 2x", tone: "good", txs: [r.transactionHash], text: `Deposited ${fmtNum(c, 2)} NVDA (${usd(c * price)} at ${usd(price)}) → ${fmtNum(xOut, 2)} xNVDA.` });
    });

  // Stable side: deposit NVDA and get sUSD, a dollar claim on the pool.
  const goStable = () =>
    run("stable", async () => {
      if (!pool || !a?.asset) return;
      let amt: bigint;
      try {
        amt = parseUnits(amount || "0", d.decimals.asset);
      } catch {
        return;
      }
      if (amt <= 0n) return;
      let out: bigint;
      try {
        [out] = (await client!.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewMintStable", args: [amt] })) as readonly [bigint, bigint];
      } catch (e) {
        return push({ label: "Stable", tone: "bad", txs: [], text: `The pool won't mint sUSD right now: ${describeError(e)}` });
      }
      if (!(await approve(a.asset, pool, amt, "Approve NVDA"))) return;
      const r = await send({ address: pool, abi: LeveragePoolAbi, functionName: "mintStable", args: [amt, minOf(out), deadline()], label: "Get sUSD" });
      if (!ok(r)) return;
      const c = toNum(amt, d.decimals.asset);
      push({ label: "Stable", tone: "good", txs: [r.transactionHash], text: `Deposited ${fmtNum(c, 2)} NVDA (${usd(c * P)}) → ${fmtNum(toNum(out), 2)} sUSD.` });
    });

  const closeAll = () =>
    run("close", async () => {
      if (!pool || posX <= 0) return;
      const x = parseUnits(posX.toFixed(18), 18);
      const xMax = u && x > u.x ? u.x : x;
      const [cOut, uOut] = (await client!.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewRedeemLever", args: [xMax] })) as readonly [bigint, bigint, bigint];
      const r = await send({ address: pool, abi: LeveragePoolAbi, functionName: "redeemLever", args: [xMax, minOf(cOut), minOf(uOut)], label: "Close position" });
      if (!ok(r)) return;
      book.addReceipt(r);
      const got = toNum(cOut, d.decimals.asset) * P + toNum(uOut, d.decimals.usdc);
      push({ label: "Close", tone: got >= usdIn ? "good" : "bad", txs: [r.transactionHash], text: `Closed for ${usd(got)} (${signed(got - usdIn, usd)} on ${usd(usdIn)}).` });
    });

  // Price moves are signed by the operator key on the server (no wallet popup).
  const setPrice = (bps: number, label: string) =>
    run(label, async () => {
      const r = await api({ action: "move", bps });
      const txs = r.txs ?? [];
      if (!r.ok) return push({ label, tone: "bad", txs, text: r.error ?? "The price move failed." });
      const at = r.price ? `NVDA ${usd(r.price)}` : "NVDA moved";
      const z = r.zone;
      if (!z) return push({ label, tone: bps > 0 ? "good" : "bad", txs, text: `${at} (${signed(bps / 10000, pct)} from live).` });
      const lev = z.levBefore !== undefined && z.levAfter !== undefined ? ` Leverage ${big(z.levBefore)} → ${big(z.levAfter)}.` : "";
      const text =
        z.kind === "sell"
          ? z.toStakers && z.sold !== undefined && z.out !== undefined
            ? `${at}. Leverage went above the band, so the pool sold ${fmtNum(z.sold, 4)} NVDA to the sUSD owners by itself, for ${fmtNum(z.out, 2)} of their sUSD (at a discount).${lev}`
            : `${at}. Leverage went above the band, so the pool sold NVDA for dollars by itself.${lev}`
          : `${at}. Leverage went below the band, so the pool bought NVDA back by itself.${lev}`;
      const many = (r.priceSteps ?? 1) > 1 ? ` The price moved in ${r.priceSteps} steps, and the pool rebalanced ${r.rebalances ?? 0} times on the way.` : "";
      push({ label, tone: "warn", txs, text: text + many });
    });

  // Opens a new sandbox pool at the live price, at about 2x. The old pool stays on the chain, unused.
  const resetPool = () =>
    run("reset", async () => {
      const r = await api({ action: "reset" });
      push(r.ok ? { label: "New pool", tone: "good", txs: r.txs ?? [], text: "A new pool is open at the live price, at about 2x." } : { label: "New pool", tone: "bad", txs: r.txs ?? [], text: r.error ?? "The new pool was not opened." });
      refresh();
    });

  const backToLive = () =>
    run("live", async () => {
      const r = await api({ action: "live" });
      push(r.ok ? { label: "Live price", tone: "muted", txs: r.txs ?? [], text: r.steps?.some((x) => x.startsWith("minted")) ? "Price back to the live Atlas NVDA price. Leverage was below the range, so new stable deposits came in and brought it back to about 2x." : "Price back to the live Atlas NVDA price." } : { label: "Live price", tone: "bad", txs: r.txs ?? [], text: r.error ?? "Reset failed." });
    });

  // ------------------------------------------------------------- render
  if (!op || (sb.loading && !sb.exists)) {
    return (
      <Shell>
        <Panel title="Loading">
          <p className="text-sm text-muted">Looking for the sandbox…</p>
        </Panel>
      </Shell>
    );
  }
  if (!op.enabled) {
    return (
      <Shell>
        <Panel title="Sandbox operator not configured">
          <p className="text-sm text-muted">Set SANDBOX_OPERATOR_KEY (a testnet-only key) in the app&apos;s server environment to run the sandbox.</p>
        </Panel>
      </Shell>
    );
  }
  if (!sb.exists) {
    return (
      <Shell>
        <Panel title="Open the NVDA sandbox">
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            The sandbox is a copy of the NVDA market on BSC testnet: same contracts and rules, starting at the live Atlas price. Its price can be moved with the buttons on this page, so you can see what a 2x position and the sUSD side do when NVDA goes up or down.
          </p>
          <button className="btn-primary mt-4" disabled={disabled} onClick={setup}>
            {busy === "setup" ? "Setting up (about a minute)…" : "Set up the sandbox"}
          </button>
        </Panel>
        <Log rows={log} />
      </Shell>
    );
  }

  const needsPrep = !!s && !!sp && s.leverage < 1.8 && s.X > 0 && posX === 0 && Math.abs(vsLive) < 0.01;
  const moves = [
    { k: "+50%", bps: 5000, tone: "text-good" },
    { k: "+10%", bps: 1000, tone: "text-good" },
    { k: "−10%", bps: -1000, tone: "text-bad" },
    { k: "−20%", bps: -2000, tone: "text-bad" },
    { k: "−50%", bps: -5000, tone: "text-bad" },
  ];

  return (
    <Shell right={pool ? <Addr a={pool} /> : null}>
      {/* price strip */}
      <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-card border border-line bg-surface px-4 py-3">
        <div className="flex items-center gap-2.5">
          <TickerIcon sym="NVDA" size={32} />
          <div>
            <div className="text-[13px] font-semibold text-ink">NVDA · sandbox</div>
            <div className="text-2xs text-faint">Live price {live ? usd(live) : "…"} (Atlas, at the last reset)</div>
          </div>
        </div>
        <Big k="NVDA price" v={s ? usd(P) : "…"} sub={live ? `${signed(vsLive, pct)} vs live` : undefined} tone={vsLive > 0.0005 ? "text-good" : vsLive < -0.0005 ? "text-bad" : "text-ink"} />
        <Big k="Pool leverage" v={s ? fmtLev(s.leverage) : "…"} sub={s ? `band ${fmtLev(s.lowerTriggerLev)}–${fmtLev(s.triggerLev)}` : undefined} tone="text-lever" />
        <Big k="sUSD backing" v={s ? (Number.isFinite(s.cr) ? fmtPct(s.cr, 0) : "∞") : "…"} sub="pool value / sUSD" tone="text-stable" />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-2xs text-faint">Move NVDA:</span>
          {moves.map((m) => (
            <button key={m.k} className={`btn btn-sm num font-semibold ${m.tone}`} disabled={disabled} onClick={() => setPrice(m.bps, m.k)}>
              {busy === m.k ? (Math.abs(m.bps) > 2000 ? "Moving…" : "…") : m.k}
            </button>
          ))}
          <button className="btn btn-sm" disabled={disabled} onClick={backToLive}>
            {busy === "live" ? "…" : "Live price"}
          </button>
          <button className="btn btn-sm" disabled={disabled} onClick={resetPool} title="Open a new pool at the live price">
            {busy === "reset" ? "Opening…" : "New pool"}
          </button>
          {(busy === "+50%" || busy === "−50%") && (
            <span className="basis-full text-right text-2xs text-warn">The price moves in 3 steps, and the pool rebalances after each step. This takes 1 to 2 minutes. The buttons are locked until it ends.</span>
          )}
        </div>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="h-[380px] overflow-hidden rounded-card border border-line bg-surface">
            <CandleChart id="nvda-flap" symbol="NVDA" leverSymbol="xNVDA" livePrice={s?.price} liveLabel="Sandbox" nav={s?.xNav} leverage={s?.leverage} interval={interval} onInterval={setIntervalSel} />
          </div>
          {/* pool now: four numbers that add up. Vault = stable side + leveraged side. Leverage = vault / leveraged side. */}
          {s &&
            (() => {
              const vS = Math.min(s.S, s.V);
              const vE = Math.max(0, s.V - vS);
              // The contract's leverage: stock value divided by the leveraged side. Vault money is not in it.
              const stock = s.C * s.price;
              const lev = vE > 0 ? stock / vE : Infinity;
              return (
                <Panel
                  title="Pool now"
                  right={
                    <span className="flex items-center gap-3">
                      {sb.owner && <Addr a={sb.owner} />}
                      <ModePill mode={s.mode} />
                    </span>
                  }
                >
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
                    <Big k="Pool total value" v={usd(s.V)} sub="NVDA + vault money" />
                    <Big k="NVDA inside" v={`${fmtNum(s.C, 2)} NVDA`} sub={`${usd(s.C * s.price)} at ${usd(s.price)}`} />
                    <Big k="Vault money" v={usd(s.U)} sub="dollars from NVDA sales" />
                    <Big k="Stable" v={usd(vS)} sub={`${fmtNum(s.S, 2)} sUSD`} tone="text-stable" />
                    <Big k="Leveraged" v={usd(vE)} sub={`${fmtNum(s.X, 2)} xNVDA`} tone="text-lever" />
                    <Big k="Leverage" v={vE > 0.005 ? fmtLev(lev) : "none"} sub={vE > 0.005 ? `NVDA ${usd(stock)} ÷ ${usd(vE)}` : "leveraged side is $0"} tone={vE <= 0.005 || lev > s.triggerLev || lev < s.lowerTriggerLev ? "text-bad" : "text-lever"} />
                  </div>
                  <div className="mt-4 flex h-2.5 overflow-hidden rounded-sm bg-surface2">
                    <div className="bg-stable" style={{ width: `${s.V > 0 ? (vS / s.V) * 100 : 0}%` }} />
                    <div className="bg-lever" style={{ width: `${s.V > 0 ? (vE / s.V) * 100 : 0}%` }} />
                  </div>
                  <p className="num mt-2 text-xs text-muted">
                    Pool {usd(s.V)} = stable {usd(vS)} + leveraged {usd(vE)}
                    {value > 0 ? ` · your part of the leveraged side: ${usd(value)} (${pct(myShare)})` : ""}
                  </p>
                </Panel>
              );
            })()}
          {/* portfolio */}
          <Panel title="Your portfolio">
            {hasPos ? (
              <>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Big k="You deposited" v={usd(usdIn)} sub={`${fmtNum(cIn, 2)} NVDA at ${usd(entry)}`} />
                  <Big k="Worth now" v={usd(value)} sub={`${fmtNum(posX, 2)} xNVDA × ${fmtUsd(nav, { digits: 4 })}`} />
                  <Big k="Profit / loss" v={signed(pnl, usd)} sub={signed(pnlPct, pct)} tone={pnl > 0.005 ? "text-good" : pnl < -0.005 ? "text-bad" : "text-ink"} />
                  <Big k="If you just held NVDA" v={usd(hold)} sub={`${signed(holdPnl, usd)} (${signed(move, pct)})`} tone="text-muted" />
                </div>
                <p className="mt-4 rounded border border-line bg-surface2 px-3 py-2 text-[13px] text-ink">
                  {Math.abs(move) < 0.0005 ? (
                    <>Your long position is open. Move NVDA with the buttons above.</>
                  ) : (
                    <>
                      NVDA moved <b className={move > 0 ? "text-good" : "text-bad"}>{signed(move, pct)}</b>, your position moved <b className={pnlPct > 0 ? "text-good" : "text-bad"}>{signed(pnlPct, pct)}</b> (≈ {fmtLev(Math.abs(move) > 0.001 ? Math.abs(pnlPct / move) : s?.leverage ?? 2)}). No liquidation, no margin call: you just own a bigger or smaller slice of the pool.
                    </>
                  )}
                </p>
                <div className="mt-3 flex justify-end">
                  <button className="btn btn-sm" disabled={disabled} onClick={closeAll}>
                    {busy === "close" ? "Closing…" : `Close for about ${usd(value)}`}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted">{!address ? "Connect your wallet, then deposit NVDA on the right to open a long position." : book.ready ? "No long position yet. Deposit NVDA on the right to open one." : "Reading your position…"}</p>
            )}
            {u && (
              <div className="num mt-3 flex flex-wrap gap-x-5 gap-y-1 text-2xs text-faint">
                <span>Wallet: {fmtNum(toNum(u.asset, d.decimals.asset), 2)} NVDA</span>
                <span>{fmtNum(toNum(u.usdc, d.decimals.usdc), 2)} mUSDC</span>
                {a?.asset && (
                  <button
                    type="button"
                    className="link disabled:opacity-50"
                    disabled={!!pending}
                    onClick={async () => {
                      const r = await send({ address: a.asset, abi: [{ type: "function", name: "faucet", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "faucet", args: [], label: "Get test NVDA" } as never);
                      if (r) refresh();
                    }}
                  >
                    Get 10 test NVDA
                  </button>
                )}
              </div>
            )}
          </Panel>


          <Log rows={log} />
        </div>

        <div className="space-y-4">
          <Panel title={side === "long" ? <span className="text-lever">Long</span> : <span className="text-stable">Stable</span>}>
            <div className="mb-3 grid grid-cols-2 gap-1 rounded border border-line bg-surface2 p-1">
              <button type="button" onClick={() => setSide("long")} className={`rounded px-2 py-1.5 text-xs font-semibold ${side === "long" ? "bg-surface text-lever shadow-sm" : "text-muted hover:text-ink"}`}>
                Long {levNow}
              </button>
              <button type="button" onClick={() => setSide("stable")} className={`rounded px-2 py-1.5 text-xs font-semibold ${side === "stable" ? "bg-surface text-stable shadow-sm" : "text-muted hover:text-ink"}`}>
                Stable
              </button>
            </div>
            <label className="text-2xs text-faint" htmlFor="sb-amt">
              Deposit NVDA
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input id="sb-amt" className="input num w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span className="text-xs text-muted">NVDA</span>
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="num text-xl font-semibold text-ink">≈ {usd((Number(amount) || 0) * P)}</span>
              <span className="num text-2xs text-faint">fee {s ? fmtPct((side === "long" ? s.leverMintFeeBps : s.stableMintFeeBps) / 10000, 2) : "–"}</span>
            </div>
            <button className="btn-primary mt-3 w-full" disabled={disabled || !s || Math.abs(vsLive) > 0.01} onClick={side === "long" ? goLong : goStable}>
              {side === "long" ? (busy === "long" ? "Opening…" : `Long ${levNow}`) : busy === "stable" ? "Minting…" : "Get sUSD"}
            </button>
            {Math.abs(vsLive) > 0.01 && <p className="mt-2 text-2xs text-warn">Open positions at the live price: new positions are blocked while the price is far from CoinMarketCap.</p>}
            <p className="mt-3 text-2xs leading-relaxed text-muted">
              {side === "long" ? `You get xNVDA, which moves about ${levNow} with NVDA now. Nobody lends to you, so it is never liquidated.` : "You get sUSD, a dollar backed by the pool. It does not move with NVDA. Stake it to earn the funding fee."}
            </p>
          </Panel>

          {needsPrep && (
            <Panel title="Set up (before the demo)">
              <button className="btn w-full" disabled={disabled} onClick={setup}>
                {busy === "setup" ? "Setting up…" : `Set leverage to 2x (now ${s ? fmtLev(s.leverage) : "…"})`}
              </button>
            </Panel>
          )}

          {s && (
            <Panel title="Pool">
              <div className="space-y-4">
                <LeverageGauge snap={s} />
                <CrGauge snap={s} />
                <SplitBar snap={s} />
              </div>
            </Panel>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1280px] px-4 pb-16 pt-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Sandbox</h1>
          <p className="mt-0.5 text-[13px] text-muted">A copy of the NVDA market on BSC testnet. Same contracts, and a price you can move with the buttons below.</p>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Log({ rows }: { rows: LogRow[] }) {
  if (!rows.length) return null;
  return (
    <Panel title="What happened">
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.id} className="rounded border border-line px-3 py-2 text-xs">
            <span className={toneCls(r.tone)}>
              <b className="text-ink">{r.label}</b> · {r.text}
            </span>
            {r.txs.length > 0 && (
              <span className="ml-2 inline-flex gap-2">
                {r.txs.map((h, i) => (
                  <a key={h} className="num link" href={txUrl(h)} target="_blank" rel="noreferrer">
                    tx{r.txs.length > 1 ? ` ${i + 1}` : ""} ↗
                  </a>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
