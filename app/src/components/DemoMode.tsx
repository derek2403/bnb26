"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { DEMO_PAGES, DEMO_STEPS, demoIndex } from "@/lib/demoFlow";

// "Demo mode": a slim bar on every demo page with the step number and Back/Next in docs/DEMO.md order.
// On by default; the choice is remembered per browser (localStorage, best effort).
const KEY = "splitstock.demoMode";
type Ctx = { on: boolean; setOn: (v: boolean) => void };
const DemoModeCtx = createContext<Ctx>({ on: true, setOn: () => {} });

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const [on, setOnState] = useState(true);
  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY);
      if (v === "off") setOnState(false);
    } catch {
      /* storage blocked: keep the default */
    }
  }, []);
  const setOn = useCallback((v: boolean) => {
    setOnState(v);
    try {
      localStorage.setItem(KEY, v ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, []);
  return <DemoModeCtx.Provider value={{ on, setOn }}>{children}</DemoModeCtx.Provider>;
}

export const useDemoMode = () => useContext(DemoModeCtx);

/** Small switch for the header. */
export function DemoModeSwitch({ className = "" }: { className?: string }) {
  const { on, setOn } = useDemoMode();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => setOn(!on)}
      title="Show the demo step bar (docs/DEMO.md order)"
      className={`inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1 text-xs text-muted hover:text-ink ${className}`}
    >
      <span className={`relative inline-block h-3.5 w-6 rounded-full transition ${on ? "bg-stable" : "bg-surface2 ring-1 ring-line"}`}>
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-all ${on ? "left-3" : "left-0.5"}`} />
      </span>
      Demo mode
    </button>
  );
}

export function DemoBar() {
  const path = usePathname();
  const { on } = useDemoMode();
  const i = demoIndex(path);
  if (!on || i < 0) return null;
  const cur = DEMO_PAGES[i];
  const prev = i > 0 ? DEMO_PAGES[i - 1] : null;
  const next = i < DEMO_PAGES.length - 1 ? DEMO_PAGES[i + 1] : null;
  return (
    <div className="border-b border-line bg-stable-soft/50">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-1.5 text-xs">
        <span className="num shrink-0 rounded-full bg-stable px-2 py-0.5 font-semibold text-white">
          Demo step {cur.step} of {DEMO_STEPS}
        </span>
        <span className="hidden shrink-0 font-medium text-ink sm:inline">{cur.title}</span>
        <span className="hidden min-w-0 truncate text-muted md:inline">{cur.cue}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {prev ? (
            <Link href={prev.href} className="btn btn-sm min-h-[26px]">
              ← Back
            </Link>
          ) : (
            <span className="btn btn-sm min-h-[26px] opacity-40">← Back</span>
          )}
          {next ? (
            <Link href={next.href} className="btn-stable btn-sm min-h-[26px]">
              <span>
                Next<span className="hidden sm:inline">: {next.title}</span>
              </span>{" "}
              →
            </Link>
          ) : (
            <Link href={DEMO_PAGES[0].href} className="btn btn-sm min-h-[26px]">
              Restart
            </Link>
          )}
        </span>
      </div>
    </div>
  );
}
