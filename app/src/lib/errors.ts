// Plain-English explanations for the custom errors a user can hit in the demo flows. describeError() appends
// these to the decoded error name, so toasts and quote boxes say why, not just which error.
const bps = (v: unknown) => `${(Number(v) / 100).toFixed(2)}%`;
const secs = (v: unknown) => `${Number(v)}s`;

const EXPLAIN: Record<string, (args: readonly unknown[]) => string> = {
  BreakerTripped: (a) => `Atlas and CMC disagree by ${bps(a[0])} (limit ${bps(a[1])}), so minting is paused. Redeems still work.`,
  StaleRefPrice: (a) => (Number(a[0]) > 1e15 ? "No CMC reference price on-chain yet (the keeper has not posted a snapshot)." : `The CMC reference is ${secs(a[0])} old (max ${secs(a[1])}). The keeper must post a fresh snapshot.`),
  StalePrice: (a) => `The Atlas price is ${secs(a[0])} old (max ${secs(a[1])}). Waiting for the next mirror update.`,
  NoPrice: () => "The price feed has no price yet.",
  FeedHalted: () => "The price feed is halted.",
  RedeemHeld: () => "The price feed is halted and the pool is underwater, so sUSD redeems are held (at most 6 hours) while the backstop covers. redeemPair still works.",
  MintsArePaused: () => "Mints are paused (breaker, halt or Guardian). Redeems still work.",
  StabilityMode: () => "The pool is in stability mode: sUSD mints are off until leverage comes down.",
  Underwater: () => "The pool is underwater (CR < 100%): mints are off and sUSD redeems pro rata.",
  LeverageTooHigh: (a) => `This mint would push leverage to ${(Number(a[0]) / 1e18).toFixed(2)}x, above the cap of ${(Number(a[1]) / 1e18).toFixed(2)}x. Mint xSTOCK first, or a smaller amount.`,
  CRTooLow: (a) => `This would leave the collateral ratio at ${((Number(a[0]) / 1e18) * 100).toFixed(0)}% (min ${((Number(a[1]) / 1e18) * 100).toFixed(0)}%).`,
  NotSeeded: () => "The pool is not seeded yet.",
  NotInZone: (a) => `Leverage ${(Number(a[0]) / 1e18).toFixed(2)}x is inside the band: no rebalance needed.`,
  Cooldown: (a) => `Rebalance cooldown: ${secs(a[0])} left.`,
  Slippage: () => "The price moved more than the 0.5% slippage guard. Try again.",
  ZeroAmount: () => "Enter an amount.",
  OutOfBounds: () => "The scenario price must stay within 0.4x–1.6x of its anchor. Click Reset first.",
  NotOperator: () => "Only the feed's operator can move this scenario price.",
  NotCoverable: () => "The backstop only covers the live pool and the shared ScenarioPool.",
  NotUnderwater: () => "The pool is not underwater (CR ≥ 100%), so there is nothing to cover.",
  NotDonor: () => "The backstop is not registered as a donor on this pool.",
  NothingToCover: () => "The backstop has nothing to spend right now.",
  StaleBnbUsd: () => "The Atlas BNB/USD price is stale, so the vault cannot value its tBNB.",
  ERC20InsufficientBalance: () => "Not enough tokens in your wallet.",
  ERC20InsufficientAllowance: () => "Approve the token first.",
  FaucetCooldown: () => "Faucet cooldown: try again later.",
};

export function explainError(name: string, args: readonly unknown[] = []): string | undefined {
  const f = EXPLAIN[name];
  if (!f) return undefined;
  try {
    return f(args);
  } catch {
    return undefined;
  }
}
