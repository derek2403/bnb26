"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, http, parseEventLogs, type Address, type Log, type TransactionReceipt } from "viem";
import { bscTestnet } from "viem/chains";
import { LeveragePoolAbi, StabilityPoolAbi } from "@/abi";
import { toNum } from "@/lib/format";

const MINT_LEVER = 1;
const REDEEM_LEVER = 3;
const CHUNK = 3_000n;
// The bnbchain seed nodes reject eth_getLogs ("limit exceeded"); publicnode serves 3000-block ranges.
const client = createPublicClient({ chain: bscTestnet, transport: http("https://bsc-testnet-rpc.publicnode.com") });

type Ev = { key: string; block: bigint; idx: number; kind: "mint" | "redeem" | "stake"; x: number; c: number; usd: number; price: number };

export type SandboxBook = {
  ready: boolean;
  /** xNVDA the user opened through Long (the first-loss seed from create() is not counted). */
  x: number;
  /** tNVDA deposited for the open part of the position, and its USD value at the fill price. */
  cIn: number;
  usdIn: number;
  /** Sum of sUSD the user staked in this sandbox's insurance pool. */
  staked: number;
  /** Merge the events of a confirmed receipt right away (public RPC nodes can lag a block or two). */
  addReceipt: (r: TransactionReceipt) => void;
};

function decode(logs: Log[], pool: Address, sp: Address | undefined, user: Address): Ev[] {
  const out: Ev[] = [];
  const me = user.toLowerCase();
  for (const e of parseEventLogs({ abi: LeveragePoolAbi, logs, strict: false })) {
    if (e.address.toLowerCase() !== pool.toLowerCase() || e.blockNumber === null || e.logIndex === null) continue;
    const key = `${e.transactionHash}:${e.logIndex}`;
    const a = e.args as Record<string, unknown>;
    if (String(a.user ?? "").toLowerCase() !== me) continue;
    if (e.eventName === "Minted" && Number(a.action) === MINT_LEVER) {
      const c = toNum(a.cIn as bigint);
      const price = toNum(a.price as bigint);
      out.push({ key, block: e.blockNumber, idx: e.logIndex, kind: "mint", x: toNum(a.out as bigint), c, usd: c * price, price });
    } else if (e.eventName === "Redeemed" && Number(a.action) === REDEEM_LEVER) {
      out.push({ key, block: e.blockNumber, idx: e.logIndex, kind: "redeem", x: toNum(a.xBurned as bigint), c: 0, usd: 0, price: toNum(a.price as bigint) });
    }
  }
  if (sp) {
    for (const e of parseEventLogs({ abi: StabilityPoolAbi, logs, eventName: "Deposited", strict: false })) {
      if (e.address.toLowerCase() !== sp.toLowerCase() || e.blockNumber === null || e.logIndex === null) continue;
      const a = e.args as Record<string, unknown>;
      if (String(a.user ?? "").toLowerCase() !== me) continue;
      out.push({ key: `${e.transactionHash}:${e.logIndex}`, block: e.blockNumber, idx: e.logIndex, kind: "stake", x: 0, c: 0, usd: toNum(a.amount as bigint), price: 0 });
    }
  }
  return out;
}

/** Average-cost book of the user's sandbox position, rebuilt from the pool's own events (no browser storage). */
export function useSandboxBook(pool?: Address, sp?: Address, user?: Address, createdAt?: number): SandboxBook {
  const [evs, setEvs] = useState<Map<string, Ev>>(new Map());
  const [ready, setReady] = useState(false);
  const scope = `${pool ?? ""}:${user ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const merge = useCallback((list: Ev[]) => {
    if (!list.length) return;
    setEvs((m) => {
      const next = new Map(m);
      for (const e of list) next.set(e.key, e);
      return next;
    });
  }, []);

  useEffect(() => {
    setEvs(new Map());
    setReady(false);
    if (!pool || !user || !createdAt) return;
    const mine = scope;
    let stop = false;
    (async () => {
      try {
        const latest = await client.getBlock();
        const back = await client.getBlock({ blockNumber: latest.number > 2000n ? latest.number - 2000n : 0n });
        const spb = Math.max(0.1, Number(latest.timestamp - back.timestamp) / Number(latest.number - back.number || 1n));
        const ago = Math.max(0, Number(latest.timestamp) - createdAt);
        const est = latest.number - BigInt(Math.ceil(ago / spb)) - 600n;
        let from = est > 0n ? est : 0n;
        const addrs = sp ? [pool, sp] : [pool];
        while (from <= latest.number && !stop) {
          const to = from + CHUNK - 1n > latest.number ? latest.number : from + CHUNK - 1n;
          const logs = await client.getLogs({ address: addrs, fromBlock: from, toBlock: to });
          if (scopeRef.current !== mine) return;
          merge(decode(logs, pool, sp, user));
          from = to + 1n;
        }
      } catch {
        /* RPC log limits: receipts from this session still fill the book */
      } finally {
        if (!stop && scopeRef.current === mine) setReady(true);
      }
    })();
    return () => {
      stop = true;
    };
  }, [pool, sp, user, createdAt, scope, merge]);

  const addReceipt = useCallback(
    (r: TransactionReceipt) => {
      if (pool && user) merge(decode(r.logs as Log[], pool, sp, user));
    },
    [pool, sp, user, merge],
  );

  // Average cost: a mint adds x and its USD cost; a redeem removes x and the same share of the cost.
  let x = 0;
  let cIn = 0;
  let usdIn = 0;
  let staked = 0;
  const sorted = [...evs.values()].sort((a, b) => (a.block === b.block ? a.idx - b.idx : a.block < b.block ? -1 : 1));
  for (const e of sorted) {
    if (e.kind === "mint") {
      x += e.x;
      cIn += e.c;
      usdIn += e.usd;
    } else if (e.kind === "redeem") {
      const f = x > 0 ? Math.min(1, e.x / x) : 1;
      x = Math.max(0, x - e.x);
      cIn *= 1 - f;
      usdIn *= 1 - f;
    } else staked += e.usd;
  }
  return { ready, x, cIn, usdIn, staked, addReceipt };
}
