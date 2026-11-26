"use client";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  binanceWallet,
  injectedWallet,
  metaMaskWallet,
  okxWallet,
  trustWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";
import { bsc, bscTestnet } from "viem/chains";
import { transports } from "./chains";

// WalletConnect project id is public by design (not a secret). Without one, only injected wallets are offered.
const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || "";

const connectors = connectorsForWallets(
  projectId
    ? [
        { groupName: "Popular", wallets: [metaMaskWallet, trustWallet, okxWallet, binanceWallet] },
        { groupName: "More", wallets: [walletConnectWallet, injectedWallet] },
      ]
    : [{ groupName: "Browser wallet", wallets: [injectedWallet] }],
  { appName: "SplitStock", projectId: projectId || "splitstock-no-walletconnect" },
);

export const wagmiConfig = createConfig({
  chains: [bscTestnet, bsc],
  connectors,
  transports: { [bscTestnet.id]: transports[bscTestnet.id], [bsc.id]: transports[bsc.id] },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
