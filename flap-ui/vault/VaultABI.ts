import { parseAbi } from "viem";

// Minimal BackstopVault fragments used by this panel. Must match contracts/src/launch/BackstopVault.sol.
// All USD values and the collateral ratio use 18 decimals (1e18 = $1 or CR 100%).
export const vaultAbi = parseAbi([
  "function bufferUsd() view returns (uint256)",
  "function pool() view returns (address)",
  "function poolCollateralRatio() view returns (uint256)",
  "function totalDefendedUsd() view returns (uint256)",
  "function canCover(address target) view returns (bool)",
  "function cover(address pool)",
]);
