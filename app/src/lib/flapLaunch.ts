// Pure helpers for opening a MORE market through a Flap launch (no React). Mirrors
// contracts/script/FlapLaunch.s.sol `newLauncher()`: SplitConfig is abi-encoded and passed to
// Portal.newLauncher(launcherFactory, data) with exactly Portal.SALT_LOCK_FEE().
import { encodeAbiParameters, parseAbi, type Address, type Hex } from "viem";

/** Minimal Portal ABI (not in src/abi: the Portal is Flap's contract). */
export const FlapPortalAbi = parseAbi([
  "function SALT_LOCK_FEE() view returns (uint256)",
  "function newLauncher(address launcherFactory, bytes data) payable returns (address launcher)",
]);

export type SplitConfigInput = {
  name: string;
  symbol: string;
  meta: string;
  salt: Hex;
  targetRaise: bigint;
  backstopSeed: bigint;
  saleDuration: bigint;
  vaultFactory: Address;
};

const SPLIT_CONFIG_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "meta", type: "string" },
      { name: "salt", type: "bytes32" },
      { name: "targetRaise", type: "uint256" },
      { name: "backstopSeed", type: "uint256" },
      { name: "saleDuration", type: "uint256" },
      { name: "vaultFactory", type: "address" },
    ],
  },
] as const;

/** abi.encode(SplitConfig): canonical, so the factory's re-encode check (`InvalidData`) passes. */
export function encodeSplitConfig(c: SplitConfigInput): Hex {
  return encodeAbiParameters(SPLIT_CONFIG_TUPLE, [c]);
}

/** Leverage is not an on-chain launch parameter: it is recorded in the launch's meta string (<= 512 bytes). */
export function buildMeta(stock: string, targetLeverage: number): string {
  return JSON.stringify({ app: "MORE", stock, targetLeverage: Math.round(targetLeverage * 10) / 10 });
}

export const byteLen = (s: string) => new TextEncoder().encode(s).length;

/** Factory bounds (SplitLauncherFactory constants). */
export const LAUNCH_BOUNDS = {
  minTarget: 5n * 10n ** 17n,
  maxTarget: 1000n * 10n ** 18n,
  minSeed: 10n ** 16n,
  minDuration: 600,
  maxDuration: 30 * 86400,
  maxName: 32,
  maxSymbol: 10,
  maxMeta: 512,
} as const;

const FLAP_ARTIFACT = "%2Fvault-ui%2Fsplitstock-backstop-launcher%2F2adfd16039f7631c971363f1dc5b95c8b378c83f07db871caba130104bbcd2f6";
export const flapLauncherUrl = (launcher: string) =>
  `https://test.utter.cash/launcher/${launcher}?chain=bnb-testnet&kind=launcher-detail&artifactPath=${FLAP_ARTIFACT}`;
