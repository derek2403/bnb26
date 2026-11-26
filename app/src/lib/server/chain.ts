import "server-only";
import { createPublicClient, fallback, http } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import { serverEnv } from "./env";

const urls = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

export const testnetClient = createPublicClient({
  chain: bscTestnet,
  transport: fallback(urls(serverEnv.testnetRpc()).map((u) => http(u))),
});

export const mainnetClient = createPublicClient({
  chain: bsc,
  transport: fallback(urls(serverEnv.mainnetRpc()).map((u) => http(u))),
});
