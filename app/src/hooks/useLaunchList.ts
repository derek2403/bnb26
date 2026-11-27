"use client";
// Read-only view of the Flap launches this browser created (written by useFlapLaunch's useMyLaunches under the
// same localStorage key). Kept in its own file so pages other than the launch form can list them, and so the list
// follows changes without a reload: the `storage` event covers other tabs, focus / visibility and a slow poll cover
// the same tab (localStorage does not fire `storage` in the tab that wrote it).
import { useEffect, useMemo, useState } from "react";
import { isAddress, type Address } from "viem";

const LS_LAUNCHES = "more.flapLaunches.v1";
const POLL_MS = 2_000;

export type LaunchEntry = {
  launcher: Address;
  token?: Address;
  stock: string;
  name: string;
  symbol?: string;
  targetLeverage?: number;
  /** wei, as a string. */
  targetRaise?: string;
  createdAt?: number;
  venue?: "four";
  pool?: Address;
};

function readRaw(): string {
  try {
    return window.localStorage.getItem(LS_LAUNCHES) ?? "";
  } catch {
    return "";
  }
}

function parse(raw: string): LaunchEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const seen = new Set<string>();
    const out: LaunchEntry[] = [];
    for (const x of v as Partial<LaunchEntry>[]) {
      if (!x || typeof x.launcher !== "string" || !isAddress(x.launcher)) continue;
      const k = x.launcher.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const stock = typeof x.stock === "string" && /^[A-Za-z]{1,6}$/.test(x.stock) ? x.stock.toUpperCase() : "NVDA";
      out.push({ ...x, launcher: x.launcher as Address, stock, name: typeof x.name === "string" && x.name ? x.name : `${stock} Market` });
    }
    return out;
  } catch {
    return [];
  }
}

/** Launches this browser created, newest first. Empty on the server and on the first client render. */
export function useLaunchList(): LaunchEntry[] {
  const [raw, setRaw] = useState("");
  useEffect(() => {
    const sync = () => setRaw(readRaw()); // same string -> React skips the re-render
    sync();
    const onStorage = (e: StorageEvent) => (e.key === null || e.key === LS_LAUNCHES) && sync();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    const t = setInterval(sync, POLL_MS);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
      clearInterval(t);
    };
  }, []);
  return useMemo(() => parse(raw), [raw]);
}
