"use client";
import "@rainbow-me/rainbowkit/styles.css";
import { darkTheme, lightTheme, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { bscTestnet } from "viem/chains";
import { wagmiConfig } from "@/config/wagmi";
import { ToastProvider } from "./Toaster";
import { DemoWalletProvider } from "./DemoWallet";

function useIsDark() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setDark(el.classList.contains("dark"));
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } } }));
  const dark = useIsDark();
  const accent = { accentColor: dark ? "#4dcdde" : "#08809e", accentColorForeground: dark ? "#0a0d12" : "#ffffff", borderRadius: "small" as const, fontStack: "system" as const };
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <RainbowKitProvider initialChain={bscTestnet} theme={dark ? darkTheme(accent) : lightTheme(accent)} modalSize="compact">
          <ToastProvider>
            <DemoWalletProvider>{children}</DemoWalletProvider>
          </ToastProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
