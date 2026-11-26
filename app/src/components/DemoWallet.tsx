"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { EMPTY_OVERLAY, type DemoOverlay } from "@/lib/demo";

// Local, per-browser state for demo pools: the viewer's simulated balances and the pool deltas their
// simulated actions caused. Stored in localStorage (a per-viewer convenience; losing it just resets the demo).
export type DemoBalances = { asset: number; sUSD: number; x: number; usdc: number };
type Store = { balances: Record<string, DemoBalances>; overlays: Record<string, DemoOverlay> };

type Ctx = {
  balances: (id: string) => DemoBalances;
  overlay: (id: string) => DemoOverlay;
  apply: (id: string, bal: Partial<DemoBalances>, ov: Partial<DemoOverlay>) => void;
  reset: (id: string) => void;
};

const KEY = "splitstock.demo.v1";
const EMPTY_BAL: DemoBalances = { asset: 0, sUSD: 0, x: 0, usdc: 0 };
const DemoCtx = createContext<Ctx | null>(null);

export function DemoWalletProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Store>({ balances: {}, overlays: {} });
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setStore(JSON.parse(raw) as Store);
    } catch {
      /* private mode or blocked storage: demo still works in memory */
    }
  }, []);
  const save = useCallback((s: Store) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }, []);
  const apply = useCallback(
    (id: string, bal: Partial<DemoBalances>, ov: Partial<DemoOverlay>) =>
      setStore((s) => {
        const b = { ...EMPTY_BAL, ...s.balances[id] };
        const o = { ...EMPTY_OVERLAY, ...s.overlays[id] };
        for (const [k, v] of Object.entries(bal)) b[k as keyof DemoBalances] = Math.max(0, b[k as keyof DemoBalances] + (v ?? 0));
        for (const [k, v] of Object.entries(ov)) o[k as keyof DemoOverlay] += v ?? 0;
        const next = { balances: { ...s.balances, [id]: b }, overlays: { ...s.overlays, [id]: o } };
        save(next);
        return next;
      }),
    [save],
  );
  const reset = useCallback(
    (id: string) =>
      setStore((s) => {
        const balances = { ...s.balances };
        const overlays = { ...s.overlays };
        delete balances[id];
        delete overlays[id];
        const next = { balances, overlays };
        save(next);
        return next;
      }),
    [save],
  );
  const value = useMemo<Ctx>(
    () => ({
      balances: (id) => ({ ...EMPTY_BAL, ...store.balances[id] }),
      overlay: (id) => ({ ...EMPTY_OVERLAY, ...store.overlays[id] }),
      apply,
      reset,
    }),
    [store, apply, reset],
  );
  return <DemoCtx.Provider value={value}>{children}</DemoCtx.Provider>;
}

export function useDemoWallet(): Ctx {
  const c = useContext(DemoCtx);
  if (!c) throw new Error("useDemoWallet outside DemoWalletProvider");
  return c;
}
