"use client";
import { useEffect, useState } from "react";
import type { Address } from "viem";

// Markets this browser launched from the launch form. One entry for each press of the launch button.
// Stored in localStorage, so the list is only for this browser.
export type MyMarket = { id: string; stock: string; more?: Address; four?: Address; fourName?: string; at: number };

const KEY = "more:my-markets:v1";
const EVENT = "more:my-markets";
// Test launches made before this time are hidden, so the list starts empty for the demo.
const HIDE_BEFORE = 1795742017393;

export function readMyMarkets(): MyMarket[] {
  if (typeof window === "undefined") return [];
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as MyMarket[];
    return Array.isArray(v) ? v.filter((m) => m.at > HIDE_BEFORE) : [];
  } catch {
    return [];
  }
}

/** Adds the entry, or merges the new fields into the entry with the same id. The newest entry is first. */
export function saveMyMarket(id: string, stock: string, patch: Partial<MyMarket>) {
  const list = readMyMarkets();
  const i = list.findIndex((m) => m.id === id);
  if (i >= 0) list[i] = { ...list[i], ...patch };
  else list.unshift({ id, stock, at: Date.now(), ...patch });
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* storage can be blocked: the list is then not kept */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useMyMarkets(): MyMarket[] {
  const [list, setList] = useState<MyMarket[]>([]);
  useEffect(() => {
    const load = () => setList(readMyMarkets());
    load();
    window.addEventListener(EVENT, load);
    return () => window.removeEventListener(EVENT, load);
  }, []);
  return list;
}
