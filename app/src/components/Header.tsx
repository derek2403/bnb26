"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { NAV_MAIN, NAV_MORE, navActive } from "@/lib/demoFlow";
import { DemoModeSwitch } from "./DemoMode";
import { ThemeToggle } from "./ThemeToggle";

function MoreMenu({ path }: { path: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const active = NAV_MORE.some((n) => navActive(n.href, path));
  return (
    <div className="relative" ref={ref}>
      <button
        className={`rounded-md px-2.5 py-1.5 text-sm ${active || open ? "bg-surface2 font-medium text-ink" : "text-muted hover:text-ink"}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        More ▾
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-64 rounded-card border border-line bg-surface p-1 shadow-lg">
          {NAV_MORE.map((n) => (
            <Link key={n.href} href={n.href} role="menuitem" className={`block rounded-md px-3 py-2 hover:bg-surface2 ${navActive(n.href, path) ? "bg-surface2" : ""}`}>
              <span className="block text-sm font-medium text-ink">{n.label}</span>
              <span className="block text-xs text-muted">{n.body}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function Header() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold text-ink">
          <span className="inline-flex h-6 w-6 overflow-hidden rounded-md">
            <span className="h-full w-1/2 bg-stable" />
            <span className="h-full w-1/2 bg-lever" />
          </span>
          SplitStock
        </Link>
        <nav className="ml-2 hidden items-center gap-0.5 xl:flex">
          {NAV_MAIN.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${navActive(n.href, path) ? "bg-surface2 font-medium text-ink" : "text-muted hover:text-ink"}`}
            >
              {n.label}
              {n.sub && <span className="ml-1 text-[10px] font-normal text-faint">{n.sub}</span>}
            </Link>
          ))}
          <MoreMenu path={path} />
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <DemoModeSwitch className="hidden sm:inline-flex" />
          <ThemeToggle />
          <ConnectButton chainStatus="icon" showBalance={false} accountStatus={{ smallScreen: "avatar", largeScreen: "address" }} />
          <button className="btn btn-sm xl:hidden" onClick={() => setOpen((o) => !o)} aria-label="Menu" aria-expanded={open}>
            ☰
          </button>
        </div>
      </div>
      {open && (
        <nav className="border-t border-line px-4 py-2 xl:hidden">
          <div className="label px-2 pb-1 pt-1">Demo order</div>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            {NAV_MAIN.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`rounded-md px-2 py-2 text-sm hover:bg-surface2 hover:text-ink ${navActive(n.href, path) ? "bg-surface2 font-medium text-ink" : "text-muted"}`}
              >
                {n.label}
                {n.sub && <span className="ml-1 text-[10px] text-faint">{n.sub}</span>}
              </Link>
            ))}
          </div>
          <div className="label px-2 pb-1 pt-3">More</div>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            {NAV_MORE.map((n) => (
              <Link key={n.href} href={n.href} className="rounded-md px-2 py-2 text-sm text-muted hover:bg-surface2 hover:text-ink">
                {n.label}
              </Link>
            ))}
          </div>
          <div className="mt-2 border-t border-line pt-2 sm:hidden">
            <DemoModeSwitch />
          </div>
        </nav>
      )}
    </header>
  );
}
