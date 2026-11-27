"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ThemeToggle } from "./ThemeToggle";

export const LAST_MARKET_KEY = "splitstock.lastMarket";
export const DEFAULT_MARKET = "nvda-flap";

/** Remember the last market a viewer opened, so "Trade" in the nav returns to it (per-browser convenience). */
export function rememberMarket(id: string) {
  try {
    localStorage.setItem(LAST_MARKET_KEY, id);
  } catch {
    /* storage blocked */
  }
}

function useTradeHref(path: string | null) {
  const [href, setHref] = useState(`/trade/${DEFAULT_MARKET}`);
  useEffect(() => {
    try {
      const id = localStorage.getItem(LAST_MARKET_KEY);
      if (id && /^[a-z0-9-]+$/.test(id)) setHref(`/trade/${id}`);
    } catch {
      /* default */
    }
  }, [path]);
  return href;
}

export function Logo() {
  return (
    // Black wordmark on a transparent background (cut from public/logos/logo.png); inverted in dark mode.
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/logos/more.png" alt="MORE" className="block h-[18px] w-auto dark:invert" />
  );
}

/** Compact wallet button sized like the rest of the header controls (RainbowKit modals behind it). */
function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openConnectModal, openAccountModal, openChainModal }) => {
        const ready = mounted;
        if (!ready) return <span className="btn btn-sm invisible h-8">Connect</span>;
        if (!account || !chain)
          return (
            <button className="btn-accent btn-sm h-8 px-3 text-[13px]" onClick={openConnectModal}>
              Connect wallet
            </button>
          );
        if (chain.unsupported)
          return (
            <button className="btn btn-sm h-8 border-bad/50 px-3 text-[13px] text-bad" onClick={openChainModal}>
              Wrong network
            </button>
          );
        return (
          <button className="btn btn-sm num h-8 px-2.5 text-[12px]" onClick={openAccountModal} title={account.address}>
            <span className="h-1.5 w-1.5 rounded-full bg-good" aria-hidden />
            {account.displayName}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}

export function Header() {
  const path = usePathname() ?? "/";
  const trade = useTradeHref(path);
  const nav = [
    { href: "/", label: "Markets", active: path === "/" },
    { href: trade, label: "Trade", active: path.startsWith("/trade") },
    { href: "/sandbox", label: "Sandbox", active: path.startsWith("/sandbox") },
    { href: "/launchpad", label: "Launch a market", active: path.startsWith("/launchpad") },
    { href: "/transparency", label: "Transparency", active: path.startsWith("/transparency") },
  ];
  const links = (cls: string) =>
    nav.map((n) => (
      <Link key={n.label} href={n.href} className={`${cls} ${n.active ? "text-ink" : "text-muted hover:text-ink"}`} aria-current={n.active ? "page" : undefined}>
        {n.label}
        {n.active && <span className="absolute inset-x-2 -bottom-px h-0.5 bg-accent" />}
      </Link>
    ));
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface">
      <div className="flex h-12 items-center gap-4 px-4">
        <Link href="/" className="shrink-0">
          <Logo />
        </Link>
        <nav className="hidden h-12 items-stretch md:flex">{links("relative flex items-center px-3 text-[13px] font-medium")}</nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="pill hidden border-warn/40 text-warn sm:inline-flex" title="BSC testnet. tNVDA, tTSLA and mUSDC are free test tokens; nothing here has real value.">
            BSC Testnet
          </span>
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
      <nav className="grid h-10 grid-cols-4 border-t border-line md:hidden">{links("relative flex items-center justify-center text-[13px] font-medium")}</nav>
    </header>
  );
}
