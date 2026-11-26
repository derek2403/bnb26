import type { Address } from "viem";
import { erc20Abi, leveragePoolAbi, uniswapV2PairAbi, uniswapV2RouterAbi } from "../abi/index.js";
import { env } from "../config/env.js";
import { testnet } from "../config/deployments.js";
import { publicClient, signer, type Signer } from "../lib/chains.js";
import { errMsg, logger } from "../lib/log.js";
import { BPS, WAD, nowSec } from "../lib/math.js";
import { listPools, type PoolRef } from "../lib/pools.js";
import { sendTx, simulate } from "../lib/tx.js";
import { MIN, SEC, type Job } from "./types.js";

const log = logger("rebalancer");
const ZONE = ["NONE", "SELL", "BUY"] as const;

/**
 * rebalancer (30 s): previewRebalance() on every pool; when a zone is active (L outside
 * [lowerTrigger, trigger], effective trigger/target already include the gap guard) and the preview says the call
 * is executable, simulate and send rebalance() from K_OPS (no roles: rebalance is permissionless).
 * LIVE pools first nudge the shared tSTOCK/mUSDC PancakeSwap pair toward the mirror price (ARB_ENABLED), so the
 * pool's oracle-bounded swap (amountOutMin = oracle × (1 − maxSlip)) can fill.
 */
export async function rebalanceOnce(dryRun = false) {
  const s = signer("ops");
  const pools = await listPools();
  const out: Record<string, unknown>[] = [];
  for (const p of pools) {
    try {
      const pv = await (s?.public ?? publicClient("testnet")).readContract({
        address: p.address,
        abi: leveragePoolAbi,
        functionName: "previewRebalance",
      });
      const zone = ZONE[Number(pv.zone)] ?? "NONE";
      if (zone === "NONE") continue;
      if (pv.cooldownLeft > 0n) {
        out.push({ pool: p.id, zone, waiting: `cooldown ${pv.cooldownLeft}s` });
        continue;
      }
      if (!s) {
        out.push({ pool: p.id, zone, skipped: "OPS_PRIVATE_KEY not set" });
        continue;
      }
      if (p.kind === "LIVE" && env().ARB_ENABLED && !dryRun) {
        const arb = await arbTowardMirror(s, p).catch((e) => ({ error: errMsg(e) }));
        if (arb) out.push({ pool: p.id, arb });
      }
      const r = await sendTx(s, "rebalancer", { address: p.address, abi: leveragePoolAbi, functionName: "rebalance" }, { dryRun, note: { pool: p.id, zone } });
      out.push({ pool: p.id, zone, chunkUsd: pv.chunkUsd.toString(), executable: pv.executable, ok: r.ok, tx: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) });
    } catch (e) {
      out.push({ pool: p.id, error: errMsg(e) });
    }
  }
  return out;
}

/** Hourly accrue() per pool (the funding fee also accrues at the start of every mutation). */
export async function accrueOnce(dryRun = false, force = false) {
  const s = signer("ops");
  const out: Record<string, unknown>[] = [];
  if (!s) return [{ skipped: "OPS_PRIVATE_KEY not set" }];
  for (const p of await listPools()) {
    try {
      const last = await s.public.readContract({ address: p.address, abi: leveragePoolAbi, functionName: "lastAccrualAt" });
      const age = nowSec() - Number(last);
      if (!force && age < 3600) continue;
      const r = await sendTx(s, "rebalancer", { address: p.address, abi: leveragePoolAbi, functionName: "accrue" }, { dryRun, note: { pool: p.id } });
      out.push({ pool: p.id, ageSec: age, ok: r.ok, tx: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) });
    } catch (e) {
      out.push({ pool: p.id, error: errMsg(e) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ arbitrage toward the mirror

function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Moves the PancakeSwap v2 pair price toward the pool's oracle price P using K_OPS inventory.
 * Constant product with fee f = 0.25%: target reserves x' = sqrt(k/P), y' = sqrt(k·P) (both in WAD units);
 * the input is the reserve delta grossed up by 1/(1−f), capped by the ops balance. minOut = quote × 99%.
 */
async function arbTowardMirror(s: Signer, p: PoolRef): Promise<Record<string, unknown> | undefined> {
  const d = testnet();
  const router = d?.dex.router;
  const pair = d?.dex.pairs?.[`t${p.symbol}_mUSDC`];
  if (!router || !pair) return undefined;
  const c = s.public;
  const [st, asset, usdc] = await Promise.all([
    c.readContract({ address: p.address, abi: leveragePoolAbi, functionName: "state" }),
    c.readContract({ address: p.address, abi: leveragePoolAbi, functionName: "asset" }),
    c.readContract({ address: p.address, abi: leveragePoolAbi, functionName: "usdc" }),
  ]);
  if (!st.priceFresh || st.price === 0n) return { skipped: "pool price not fresh" };
  const [reserves, token0, aDec, uDec] = await Promise.all([
    c.readContract({ address: pair, abi: uniswapV2PairAbi, functionName: "getReserves" }),
    c.readContract({ address: pair, abi: uniswapV2PairAbi, functionName: "token0" }),
    c.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }),
    c.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const assetIs0 = token0.toLowerCase() === asset.toLowerCase();
  const rA = BigInt(assetIs0 ? reserves[0] : reserves[1]);
  const rU = BigInt(assetIs0 ? reserves[1] : reserves[0]);
  if (rA === 0n || rU === 0n) return { skipped: "empty pair" };
  const sA = 10n ** BigInt(18 - Number(aDec));
  const sU = 10n ** BigInt(18 - Number(uDec));
  const x = rA * sA; // WAD asset
  const y = rU * sU; // WAD usd
  const pairPrice = (y * WAD) / x;
  const P = st.price;
  const devBps = ((pairPrice > P ? pairPrice - P : P - pairPrice) * BPS) / P;
  if (devBps < BigInt(env().ARB_THRESHOLD_BPS)) return undefined;
  const k = x * y;
  const feeNum = 9975n; // 0.25% PCS v2 fee
  let tokenIn: Address;
  let tokenOut: Address;
  let amountIn: bigint;
  if (pairPrice > P) {
    // asset too expensive on the pair -> sell asset
    const xT = isqrt((k * WAD) / P);
    amountIn = ((xT - x) * BPS) / feeNum / sA;
    tokenIn = asset;
    tokenOut = usdc;
  } else {
    const yT = isqrt((k * P) / WAD);
    amountIn = ((yT - y) * BPS) / feeNum / sU;
    tokenIn = usdc;
    tokenOut = asset;
  }
  const bal = await c.readContract({ address: tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [s.account.address] });
  if (amountIn > bal) amountIn = bal;
  if (amountIn === 0n) return { skipped: "no ops inventory", devBps: devBps.toString() };
  const quote = await simulate(s, { address: router, abi: uniswapV2RouterAbi, functionName: "getAmountsOut", args: [amountIn, [tokenIn, tokenOut]] });
  if (!quote.ok) return { skipped: "quote failed", error: quote.revert ?? quote.error };
  const amounts = quote.result as readonly bigint[];
  const minOut = (amounts[amounts.length - 1] * 99n) / 100n;
  const allowance = await c.readContract({ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [s.account.address, router] });
  if (allowance < amountIn) {
    const a = await sendTx(s, "rebalancer", { address: tokenIn, abi: erc20Abi, functionName: "approve", args: [router, amountIn] });
    if (!a.ok) return { skipped: "approve failed", error: a.revert ?? a.error };
  }
  const r = await sendTx(
    s,
    "rebalancer",
    {
      address: router,
      abi: uniswapV2RouterAbi,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, minOut, [tokenIn, tokenOut], s.account.address, BigInt(nowSec() + 300)],
    },
    { note: { arb: p.symbol, devBps: devBps.toString() } },
  );
  log.info("arb", { pool: p.id, devBps: devBps.toString(), amountIn: amountIn.toString(), ok: r.ok });
  return { devBps: devBps.toString(), amountIn: amountIn.toString(), tokenIn, ok: r.ok, tx: r.hash };
}

export const rebalancerJob: Job = { name: "rebalance", everyMs: 30 * SEC, run: (ctx) => rebalanceOnce(ctx.dryRun) };
export const accrueJob: Job = { name: "accrue", everyMs: 10 * MIN, run: (ctx) => accrueOnce(ctx.dryRun, false) };
