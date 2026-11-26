import { parseAbi } from "viem";

// Minimal ABI fragments for the SplitStock NVDA pool Mini App (BSC Testnet, chain 97).
// Every signature here is byte-identical to the reviewed manifest walletContracts entries.
// Source contracts: contracts/src/core/LeveragePool.sol, StabilityPool.sol and the tNVDA test token (faucet only).
// Approvals go through sdk.approveErc20 with per-transaction amounts; there is no signature-based approval path.

export const poolAbi = parseAbi([
  "function state() view returns ((uint256 C, uint256 U, uint256 S, uint256 X, uint256 price, uint256 priceUpdatedAt, uint256 priceAge, bool priceFresh, bool feedHalted, uint256 V, int256 E, uint256 xNav, uint256 leverage, uint256 collateralRatio, uint8 mode, bool marketOpen, bool gapGuard, bool mintsPaused, uint256 triggerLev, uint256 targetLev, uint256 lowerTriggerLev, uint256 maxMintLev, uint256 stableMintFeeBps, uint256 leverMintFeeBps, uint8 riskSource, uint256 snapshotId) st)",
  "function maxMintStable() view returns (uint256 cInMax)",
  "function xToken() view returns (address)",
  "function usdc() view returns (address)",
  "function previewMintStable(uint256 cIn) view returns (uint256 sOut, uint256 feeBps)",
  "function previewMintLever(uint256 cIn) view returns (uint256 xOut, uint256 feeBps)",
  "function previewRedeemStable(uint256 s) view returns (uint256 cOut, uint256 uOut, uint256 feeBps)",
  "function previewRedeemLever(uint256 x) view returns (uint256 cOut, uint256 uOut, uint256 feeBps)",
  "function previewRedeemPair(uint256 sMax, uint256 xMax) view returns (uint256 sBurned, uint256 xBurned, uint256 cOut, uint256 uOut)",
  "function mintStable(uint256 cIn, uint256 minOut, uint256 deadline) returns (uint256)",
  "function mintLever(uint256 cIn, uint256 minOut, uint256 deadline) returns (uint256)",
  "function redeemStable(uint256 s, uint256 minC, uint256 minU) returns (uint256 cOut, uint256 uOut)",
  "function redeemLever(uint256 x, uint256 minC, uint256 minU) returns (uint256 cOut, uint256 uOut)",
  "function redeemPair(uint256 sMax, uint256 xMax, uint256 minC, uint256 minU) returns (uint256 sBurned, uint256 xBurned, uint256 cOut, uint256 uOut)",
]);

export const stabilityPoolAbi = parseAbi([
  "function totalDeposits() view returns (uint256)",
  "function depositOf(address user) view returns (uint256)",
  "function gainsOf(address user) view returns (uint256 assetGain, uint256 stableReward)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function claimGains() returns (uint256 assetGain, uint256 stableReward)",
]);

export const faucetAbi = parseAbi([
  "function faucetAmount() view returns (uint256)",
  "function faucetCooldown() view returns (uint256)",
  "function lastFaucetAt(address who) view returns (uint256 ts)",
  "function faucet() returns (uint256 amount)",
]);

// Custom errors the pool, the insurance vault and the test token can revert with. Used only to decode revert data.
export const errorAbi = parseAbi([
  "error BadPairRatio()",
  "error BelowDust(uint256 usd, uint256 minUsd)",
  "error BreakerTripped(uint256 devBps, uint256 maxDevBps)",
  "error CRTooLow(uint256 crAfter, uint256 min)",
  "error Expired(uint256 deadline)",
  "error FeedHalted()",
  "error InsufficientReserves()",
  "error LeverageTooHigh(uint256 levAfter, uint256 cap)",
  "error MintsArePaused()",
  "error NoPrice()",
  "error NotSeeded()",
  "error RedeemHeld()",
  "error Slippage(uint256 got, uint256 min)",
  "error SlippageC(uint256 got, uint256 min)",
  "error SlippageU(uint256 got, uint256 min)",
  "error StabilityMode()",
  "error StalePrice(uint256 age, uint256 maxAge)",
  "error StaleRefPrice(uint256 age, uint256 maxAge)",
  "error Underwater()",
  "error ZeroAmount()",
  "error ZeroOutput()",
  "error InsufficientDeposit(uint256 have, uint256 want)",
  "error NoDeposits()",
  "error FaucetCooldown(uint256 secondsLeft)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);
