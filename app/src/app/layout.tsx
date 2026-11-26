import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Header } from "@/components/Header";
import { THEME_SCRIPT } from "@/components/ThemeToggle";
import { MockBanner } from "@/components/ui";
import { DemoBar } from "@/components/DemoMode";

export const metadata: Metadata = {
  title: "SplitStock",
  description: "Tokenized stock split into a stock-backed dollar (sUSD) and leverage that is never liquidated (xSTOCK). BSC testnet.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f9fc" },
    { media: "(prefers-color-scheme: dark)", color: "#080b11" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
        />
      </head>
      <body className="min-h-screen font-sans">
        <Providers>
          <MockBanner />
          <Header />
          <DemoBar />
          <main className="mx-auto max-w-7xl px-4 pb-16 pt-6">{children}</main>
          <footer className="mx-auto max-w-7xl px-4 pb-10 text-xs text-faint">
            SplitStock · BNB Hack Bangkok · BSC testnet (97) writes, mainnet (56) read-only. Prior art: f(x) Protocol (AladdinDAO). Testnet assets are mocks.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
