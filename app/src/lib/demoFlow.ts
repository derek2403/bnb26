// The demo in docs/DEMO.md: 7 scenes over 8 pages, in this order. The header nav, the "Demo step N of 7" bar and
// its Back/Next buttons all read from this list, so the app always follows the recording script.
export type DemoPage = {
  href: string;
  /** Scene number in docs/DEMO.md (1-7). /risk and /agent share scene 5. */
  step: number;
  title: string;
  /** What to do on this page, one line (from the DEMO.md "What you do" column). */
  cue: string;
};

export const DEMO_STEPS = 7;

export const DEMO_PAGES: DemoPage[] = [
  { href: "/pools", step: 1, title: "Pools", cue: "Scroll the list. NVDA was opened by Flap, TSLA by Four.meme." },
  { href: "/launch", step: 2, title: "Flap launch", cue: "Contribute the remaining amount, then click Open pool." },
  { href: "/pools/nvda-flap", step: 3, title: "NVDA pool", cue: "Mint xNVDA, then mint sUSD. Show the split bar, leverage, the Atlas price chip and the market pill." },
  { href: "/scenario", step: 4, title: "Scenario", cue: "Click −22% (sell zone), then the CMC deviation shock (breaker), then −55% (backstop)." },
  { href: "/risk", step: 5, title: "Risk", cue: "Show Atlas vs CMC, the volatility and the current trigger." },
  { href: "/agent", step: 5, title: "AI agent", cue: "Open the latest proposal: stricter limits before the half day or weekend." },
  { href: "/memes", step: 6, title: "Four.meme launch", cue: "Open the tTSLA meme, buy the remaining part. Graduation opens the TSLA pool." },
  { href: "/proof", step: 7, title: "Proof", cue: "Show the address list, the BscScan links and one verified CMC log." },
];

/** The demo page index for a pathname, or -1. /memes/<token> counts as the /memes page. */
export function demoIndex(path: string | null | undefined): number {
  if (!path) return -1;
  const p = path.replace(/\/+$/, "") || "/";
  const exact = DEMO_PAGES.findIndex((d) => d.href === p);
  if (exact >= 0) return exact;
  if (p.startsWith("/memes/") && p !== "/memes/new") return DEMO_PAGES.findIndex((d) => d.href === "/memes");
  return -1;
}

/** Header nav, in demo order. Secondary pages go to the "More" menu. */
export const NAV_MAIN: { href: string; label: string; sub?: string }[] = [
  { href: "/pools", label: "Pools" },
  { href: "/launch", label: "Launch", sub: "Flap" },
  { href: "/pools/nvda-flap", label: "NVDA pool" },
  { href: "/scenario", label: "Scenario" },
  { href: "/risk", label: "Risk" },
  { href: "/agent", label: "AI Agent" },
  { href: "/memes", label: "Memes", sub: "Four.meme" },
  { href: "/proof", label: "Proof" },
];

export const NAV_MORE: { href: string; label: string; body: string }[] = [
  { href: "/", label: "Overview", body: "What SplitStock is, in one page" },
  { href: "/backstop", label: "Backstop", body: "Flap vault and OpenFour treasury" },
  { href: "/backtest", label: "Backtest", body: "30 days of NVDA through the zones" },
  { href: "/status", label: "Status", body: "Keeper, jobs and wallets" },
  { href: "/memes/new", label: "Create a meme", body: "New tTSLA fair launch on our OpenFour fork" },
];

/** Is a nav item active for this path? /pools is active for every pool page except the NVDA one. */
export function navActive(href: string, path: string | null | undefined): boolean {
  const p = (path ?? "").replace(/\/+$/, "") || "/";
  if (href === "/pools/nvda-flap") return p === "/pools/nvda-flap";
  if (href === "/pools") return p === "/pools" || (p.startsWith("/pools/") && p !== "/pools/nvda-flap");
  if (href === "/") return p === "/";
  if (href === "/memes") return p === "/memes" || (p.startsWith("/memes/") && p !== "/memes/new");
  return p === href || p.startsWith(`${href}/`);
}
