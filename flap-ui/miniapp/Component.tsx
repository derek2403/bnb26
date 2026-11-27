"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeErrorResult, formatUnits, toFunctionSelector } from "viem";
import type { Address, SimulateResult } from "@/src/sdk";
import { formatPercentBps, formatTokenAmount, getTxErrorKind, parseTokenAmount, useFlapSdk } from "@/src/sdk";
import { Activity, Droplets, ShieldCheck, Wallet } from "lucide-react";
import { AddressLink, Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Metric, StatusBadge, TxButton } from "@/src/ui";
import type { TxButtonState } from "@/src/ui";
import { errorAbi, faucetAbi, poolAbi, stabilityPoolAbi } from "./VaultABI";

// SplitStock NVDA pool on BSC Testnet (97). Fixed, reviewed targets only: the pool, its insurance vault
// (StabilityPool) and the tNVDA test token faucet. Users never type addresses.
const CHAIN_ID = 97;
const POOL = "0x0CD861cd0dD919434019f18F71630D2F678CD208";
const STABILITY_POOL = "0x36Fe40CE6925fd1711ae3aC9e89c3348E1354d07";
const TNVDA = "0x5Df0DC395E7686bcDc41f75891f1Ab982476fddd";
const SUSD = "0xe1F327e5D9B6DC7542a111C4c978673b07918011";

// Per-transaction approval caps; they must match manifest walletContracts[].erc20Approval.maxApprovalWei.
const POOL_APPROVAL_CAP = 50n * 10n ** 18n;
const STABILITY_APPROVAL_CAP = 10_000n * 10n ** 18n;
const SLIPPAGE_BPS = 50n; // 0.5%
const DEADLINE_SECONDS = 20 * 60;
const REFRESH_MS = 15_000;
const ONE = 10n ** 18n;

type PoolAction = "mintLever" | "mintStable" | "redeemStable" | "redeemLever" | "redeemPair";
type Tab = PoolAction | "insurance";
type InsuranceAction = "deposit" | "withdraw";

// redeemFeeBps of the pool (0.2%). Used only for the redeemPair fee line; the other redeem quotes return their fee
// from the pool (redeemLever is 1% in stability mode). The admin can change redeemFeeBps, up to 1%.
const REDEEM_FEE_BPS = 20n;

const TABS: Tab[] = ["mintLever", "mintStable", "redeemStable", "redeemLever", "redeemPair", "insurance"];
const MODE_KEYS = ["unseeded", "normal", "stability", "underwater", "noPrice"];

interface PoolState {
  C: bigint; U: bigint; S: bigint; X: bigint; price: bigint; priceUpdatedAt: bigint; priceAge: bigint; priceFresh: boolean; feedHalted: boolean;
  V: bigint; E: bigint; xNav: bigint; leverage: bigint; collateralRatio: bigint; mode: number; marketOpen: boolean; gapGuard: boolean; mintsPaused: boolean;
  triggerLev: bigint; targetLev: bigint; lowerTriggerLev: bigint; maxMintLev: bigint; stableMintFeeBps: bigint; leverMintFeeBps: bigint; riskSource: number; snapshotId: bigint;
}

interface PoolTokens {
  lever: Address;
  usdc: Address;
}

interface Snapshot {
  state: PoolState | null;
  maxMintStable: bigint | null;
  spTotal: bigint | null;
  faucetAmount: bigint | null;
  faucetCooldown: bigint | null;
}

interface UserSnapshot {
  asset: bigint | null;
  sUSD: bigint | null;
  x: bigint | null;
  usdc: bigint | null;
  spDeposit: bigint | null;
  spAssetGain: bigint | null;
  spStableReward: bigint | null;
  lastFaucetAt: bigint | null;
}

interface Quote {
  out?: bigint;
  cOut?: bigint;
  uOut?: bigint;
  sBurned?: bigint;
  xBurned?: bigint;
  xMax?: bigint;
  feeBps?: bigint;
  error?: string;
}

interface DecodedError {
  name: string;
  args: readonly unknown[];
}

const ERROR_SELECTORS = errorAbi
  .filter((item) => item.type === "error")
  .map((item) => ({ name: item.name, selector: toFunctionSelector(`${item.name}(${item.inputs.map((input) => input.type).join(",")})`) }));

function settled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

function minOf(value?: bigint) {
  return value ? (value * (10_000n - SLIPPAGE_BPS)) / 10_000n : 0n;
}

function deadline() {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
}

function amountText(value: bigint | null | undefined, decimals = 18, precision = 4) {
  return value === null || value === undefined ? null : formatTokenAmount(value, decimals, precision);
}

function usdText(value: bigint | null | undefined, precision = 2) {
  if (value === null || value === undefined) return null;
  return value < 0n ? "-$" + formatTokenAmount(-value, 18, precision) : "$" + formatTokenAmount(value, 18, precision);
}

function leverageText(value: bigint | null | undefined) {
  if (value === null || value === undefined) return null;
  // The pool reports uint256 max when equity is zero or negative.
  if (value > 10n ** 24n) return "∞";
  return formatTokenAmount(value, 18, 2) + "x";
}

function ratioText(value: bigint | null | undefined) {
  if (value === null || value === undefined) return null;
  if (value > 10n ** 24n) return "∞";
  return formatTokenAmount(value * 100n, 18, 1) + "%";
}

function durationText(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function parseAmount(input: string, decimals = 18): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return parseTokenAmount(trimmed, decimals);
  } catch {
    return null;
  }
}

function collectRevertCandidates(error: unknown, depth = 0, found: DecodedError[] = [], hex: string[] = []) {
  if (depth > 6 || error === null || error === undefined) return { found, hex };
  if (typeof error === "string") {
    for (const match of error.match(/0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{64})*(?![0-9a-fA-F])/g) ?? []) hex.push(match);
    return { found, hex };
  }
  if (typeof error !== "object") return { found, hex };
  const record = error as Record<string, unknown>;
  if (typeof record.errorName === "string") found.push({ name: record.errorName, args: Array.isArray(record.args) ? record.args : [] });
  for (const key of ["raw", "data", "signature"]) {
    const value = record[key];
    if (typeof value === "string" && /^0x[0-9a-fA-F]{8,}$/.test(value)) hex.push(value);
    else if (value && typeof value === "object") collectRevertCandidates(value, depth + 1, found, hex);
  }
  for (const key of ["shortMessage", "message", "details", "metaMessages"]) {
    const value = record[key];
    if (typeof value === "string") collectRevertCandidates(value, depth + 1, found, hex);
    else if (Array.isArray(value)) for (const line of value) collectRevertCandidates(line, depth + 1, found, hex);
  }
  collectRevertCandidates(record.cause, depth + 1, found, hex);
  return { found, hex };
}

function decodeRevert(error: unknown): DecodedError | null {
  const { found, hex } = collectRevertCandidates(error);
  const known = found.find((item) => ERROR_SELECTORS.some((entry) => entry.name === item.name));
  if (known) return known;
  // Prefer full revert data (selector + arguments); fall back to a bare selector match.
  for (const data of hex) {
    try {
      const decoded = decodeErrorResult({ abi: errorAbi, data: data as `0x${string}` });
      return { name: decoded.errorName, args: decoded.args ?? [] };
    } catch {
      // Not decodable on its own (for example a bare 4-byte signature); try the next candidate.
    }
  }
  for (const data of hex) {
    const match = ERROR_SELECTORS.find((entry) => entry.selector === data.slice(0, 10).toLowerCase());
    if (match) return { name: match.name, args: [] };
  }
  return null;
}

function errorParams(decoded: DecodedError): Record<string, string> {
  const [a0, a1] = decoded.args.map((value) => (typeof value === "bigint" ? value : 0n));
  switch (decoded.name) {
    case "LeverageTooHigh":
      return { value: leverageText(a0) ?? "", cap: leverageText(a1) ?? "" };
    case "CRTooLow":
      return { value: ratioText(a0) ?? "", cap: ratioText(a1) ?? "" };
    case "BreakerTripped":
      return { value: formatPercentBps(a0), cap: formatPercentBps(a1) };
    case "StalePrice":
    case "StaleRefPrice":
      return { value: durationText(Number(a0 ?? 0n)), cap: durationText(Number(a1 ?? 0n)) };
    case "FaucetCooldown":
      return { value: durationText(Number(a0 ?? 0n)) };
    case "InsufficientDeposit":
      return { value: amountText(a0) ?? "", cap: amountText(a1) ?? "" };
    case "BelowDust":
      return { value: usdText(a0) ?? "", cap: usdText(a1) ?? "" };
    default:
      return {};
  }
}

// Static i18n key builder for dynamic suffixes (keys are listed in i18n.json for both locales).
function key(prefix: string, name: string) {
  return prefix + name;
}

function readTuple(value: unknown): readonly bigint[] {
  return Array.isArray(value) ? (value as bigint[]) : [];
}

export default function SplitstockPoolApp() {
  const sdk = useFlapSdk({ chainId: CHAIN_ID });
  const { wallet, i18n } = sdk;
  const t = i18n.t;
  const account = wallet.isConnected ? wallet.address : undefined;
  const wrongNetwork = wallet.isWrongNetwork;

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [user, setUser] = useState<UserSnapshot | null>(null);
  const [usdcDecimals, setUsdcDecimals] = useState(18);
  const [poolTokens, setPoolTokens] = useState<PoolTokens | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<Tab>("mintLever");
  const [insuranceAction, setInsuranceAction] = useState<InsuranceAction>("deposit");
  const [input, setInput] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [txState, setTxState] = useState<TxButtonState>("idle");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Address | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const resetTimer = useRef<number | null>(null);

  const describeError = useCallback(
    (cause: unknown) => {
      const decoded = decodeRevert(cause);
      if (decoded) {
        const params = errorParams(decoded);
        // Without decoded arguments, use the short message variant (no numbers) when the error has one.
        const name = Object.keys(params).length && !decoded.args.length ? decoded.name + "Short" : decoded.name;
        return t(key("chainErrors.", name), t("chainErrors.generic", undefined, { name: decoded.name }), params);
      }
      const text = cause && typeof cause === "object" && "message" in cause ? String((cause as { message?: unknown }).message ?? "") : String(cause ?? "");
      if (/preview fixtures/i.test(text)) return t("errors.previewFixture");
      if (/approval-cap-exceeded/.test(text)) return t("errors.approvalCap");
      if (/wallet account changed/i.test(text)) return t("errors.accountChanged");
      const kind = getTxErrorKind(cause);
      return t(key("txErrors.", kind));
    },
    [t],
  );

  const loadPool = useCallback(async () => {
    const results = await Promise.allSettled([
      sdk.readContract<PoolState>({ address: POOL, abi: poolAbi, functionName: "state" }),
      sdk.readContract<bigint>({ address: POOL, abi: poolAbi, functionName: "maxMintStable" }),
      sdk.readContract<bigint>({ address: STABILITY_POOL, abi: stabilityPoolAbi, functionName: "totalDeposits" }),
      sdk.readContract<bigint>({ address: TNVDA, abi: faucetAbi, functionName: "faucetAmount" }),
      sdk.readContract<bigint>({ address: TNVDA, abi: faucetAbi, functionName: "faucetCooldown" }),
    ]);
    setSnapshot({
      state: settled(results[0]),
      maxMintStable: settled(results[1]),
      spTotal: settled(results[2]),
      faucetAmount: settled(results[3]),
      faucetCooldown: settled(results[4]),
    });
    setLoadFailed(results[0].status === "rejected");
  }, [sdk]);

  const loadUser = useCallback(async () => {
    if (!account) {
      setUser(null);
      return;
    }
    const results = await Promise.allSettled([
      sdk.readErc20Balance(TNVDA),
      sdk.readErc20Balance(SUSD),
      poolTokens ? sdk.readErc20Balance(poolTokens.lever) : Promise.resolve(null),
      poolTokens ? sdk.readErc20Balance(poolTokens.usdc) : Promise.resolve(null),
      sdk.readContract<bigint>({ address: STABILITY_POOL, abi: stabilityPoolAbi, functionName: "depositOf", args: [account] }),
      sdk.readContract<readonly bigint[]>({ address: STABILITY_POOL, abi: stabilityPoolAbi, functionName: "gainsOf", args: [account] }),
      sdk.readContract<bigint>({ address: TNVDA, abi: faucetAbi, functionName: "lastFaucetAt", args: [account] }),
    ]);
    const gains = readTuple(settled(results[5]));
    setUser({
      asset: settled(results[0]),
      sUSD: settled(results[1]),
      x: settled(results[2]),
      usdc: settled(results[3]),
      spDeposit: settled(results[4]),
      spAssetGain: gains[0] ?? null,
      spStableReward: gains[1] ?? null,
      lastFaucetAt: settled(results[6]),
    });
  }, [account, poolTokens, sdk]);

  const reload = useCallback(async () => {
    await Promise.allSettled([loadPool(), loadUser()]);
  }, [loadPool, loadUser]);

  // The pool's own xNVDA and mUSDC token addresses (display and balance reads only; never approved or written).
  useEffect(() => {
    let live = true;
    void Promise.all([
      sdk.readContract<Address>({ address: POOL, abi: poolAbi, functionName: "xToken" }),
      sdk.readContract<Address>({ address: POOL, abi: poolAbi, functionName: "usdc" }),
    ])
      .then(async ([lever, usdc]) => {
        if (!live) return;
        setPoolTokens({ lever, usdc });
        const meta = await sdk.readErc20Metadata(usdc, { decimalsOnly: true });
        if (live) setUsdcDecimals(meta.decimals);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sdk]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => {
      void reload();
      setNowSec(Math.floor(Date.now() / 1000));
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const state = snapshot?.state ?? null;
  const amount = parseAmount(input);
  const isMint = tab === "mintLever" || tab === "mintStable";
  const isDeposit = tab === "insurance" && insuranceAction === "deposit";
  const needsApprovalFlow = isMint || isDeposit;

  const balanceFor = (): bigint | null => {
    if (!user) return null;
    if (isMint) return user.asset;
    if (tab === "redeemLever") return user.x;
    if (tab === "insurance") return insuranceAction === "deposit" ? user.sUSD : user.spDeposit;
    return user.sUSD;
  };
  const balance = balanceFor();
  const inputUnit = isMint ? t("tokens.asset") : tab === "redeemLever" ? t("tokens.lever") : t("tokens.stable");

  const fetchQuote = useCallback(
    async (action: Tab, value: bigint): Promise<Quote> => {
      try {
        switch (action) {
          case "mintStable": {
            const [out, feeBps] = readTuple(await sdk.readContract({ address: POOL, abi: poolAbi, functionName: "previewMintStable", args: [value] }));
            return { out, feeBps };
          }
          case "mintLever": {
            const [out, feeBps] = readTuple(await sdk.readContract({ address: POOL, abi: poolAbi, functionName: "previewMintLever", args: [value] }));
            return { out, feeBps };
          }
          case "redeemStable": {
            const [cOut, uOut, feeBps] = readTuple(await sdk.readContract({ address: POOL, abi: poolAbi, functionName: "previewRedeemStable", args: [value] }));
            return { cOut, uOut, feeBps };
          }
          case "redeemLever": {
            const [cOut, uOut, feeBps] = readTuple(await sdk.readContract({ address: POOL, abi: poolAbi, functionName: "previewRedeemLever", args: [value] }));
            return { cOut, uOut, feeBps };
          }
          case "redeemPair": {
            const supply = state?.S ?? 0n;
            const levered = state?.X ?? 0n;
            // xMax in the pool's current sUSD:xNVDA ratio (+0.1%), capped at the wallet balance.
            let xMax = supply > 0n ? (value * levered * 1001n) / (supply * 1000n) : 0n;
            if (user?.x !== null && user?.x !== undefined && xMax > user.x) xMax = user.x;
            const [sBurned, xBurned, cOut, uOut] = readTuple(await sdk.readContract({ address: POOL, abi: poolAbi, functionName: "previewRedeemPair", args: [value, xMax] }));
            return { sBurned, xBurned, cOut, uOut, xMax, feeBps: REDEEM_FEE_BPS };
          }
          default:
            return {};
        }
      } catch (cause) {
        return { error: describeError(cause) };
      }
    },
    [sdk, state?.S, state?.X, user?.x, describeError],
  );

  // Debounced preview quote for the current input.
  useEffect(() => {
    let live = true;
    setQuote(null);
    if (!amount || amount <= 0n || tab === "insurance") return;
    const timer = window.setTimeout(() => {
      void fetchQuote(tab, amount).then((next) => {
        if (live) setQuote(next);
      });
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, input, state?.snapshotId, state?.price, fetchQuote]);

  const readAllowance = useCallback(async (): Promise<bigint | null> => {
    if (!account) return null;
    try {
      if (isMint) return (await sdk.readErc20Approval({ contractId: "splitstock-pool", token: TNVDA })).allowance;
      if (isDeposit) return (await sdk.readErc20Approval({ contractId: "splitstock-stability-pool", token: SUSD })).allowance;
    } catch {
      return null;
    }
    return null;
  }, [account, isDeposit, isMint, sdk]);

  useEffect(() => {
    let live = true;
    setAllowance(null);
    if (!needsApprovalFlow || !account) return;
    void readAllowance().then((value) => {
      if (live) setAllowance(value);
    });
    return () => {
      live = false;
    };
  }, [needsApprovalFlow, account, readAllowance, tab, insuranceAction, snapshot]);

  const approvalCap = isDeposit ? STABILITY_APPROVAL_CAP : POOL_APPROVAL_CAP;
  const needsApproval = needsApprovalFlow && amount !== null && amount > 0n && (allowance === null || allowance < amount);
  const overCap = needsApproval && amount !== null && amount > approvalCap;
  const insufficient = balance !== null && amount !== null && amount > balance;
  const busy = busyAction !== null;

  const modeKey = state ? (MODE_KEYS[state.mode] ?? "normal") : null;
  const mintBlocked = !!state && (state.mintsPaused || state.feedHalted || modeKey === "underwater" || modeKey === "noPrice" || modeKey === "unseeded");
  const stableMintBlocked = mintBlocked || modeKey === "stability";

  const disabledReason = !state
    ? t("states.loading")
    : tab === "redeemPair" && user?.x === 0n
      ? t("errors.needsPair")
      : !amount || amount <= 0n
      ? t("errors.enterAmount")
      : insufficient
        ? t("errors.insufficient", undefined, { token: inputUnit })
        : tab === "mintStable" && stableMintBlocked
          ? t("errors.mintStableBlocked")
          : tab === "mintLever" && mintBlocked
            ? t("errors.mintBlocked")
            : overCap
              ? t("errors.approvalCapDetail", undefined, { cap: amountText(approvalCap, 18, 0) ?? "", token: inputUnit })
              : quote?.error
                ? t("errors.quoteBlocked")
                : null;

  function scheduleReset() {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      resetTimer.current = null;
      setTxState("idle");
    }, 1500);
  }

  // Simulate first, then write, then wait for a successful receipt.
  async function execute(simulate: () => Promise<SimulateResult>): Promise<boolean> {
    setTxState("simulating");
    const prepared = await simulate();
    setTxState("writing");
    const hash = await sdk.writeContract(prepared.request);
    setLastTx(hash);
    setTxState("confirming");
    const receipt = await sdk.waitForTx(hash);
    return receipt.status === "success";
  }

  // Approve exactly the amount this transaction needs (never unlimited), wait, then re-check the allowance.
  async function ensureAllowance(value: bigint): Promise<boolean> {
    const current = await readAllowance();
    if (current !== null && current >= value) return true;
    if (value > approvalCap) {
      setError(t("errors.approvalCapDetail", undefined, { cap: amountText(approvalCap, 18, 0) ?? "", token: inputUnit }));
      return false;
    }
    setTxState("approving");
    const hash = isDeposit
      ? await sdk.approveErc20({ contractId: "splitstock-stability-pool", token: SUSD, amount: value, account })
      : await sdk.approveErc20({ contractId: "splitstock-pool", token: TNVDA, amount: value, account });
    setLastTx(hash);
    setTxState("approval_confirming");
    const receipt = await sdk.waitForTx(hash);
    if (receipt.status !== "success") {
      setError(t("errors.approvalReverted"));
      return false;
    }
    const updated = await readAllowance();
    setAllowance(updated);
    if (updated === null || updated < value) {
      setError(t("errors.approvalNotApplied"));
      return false;
    }
    return true;
  }

  async function runPoolAction(action: PoolAction, value: bigint) {
    // Re-quote right before sending so minOut reflects the latest pool state.
    const fresh = await fetchQuote(action, value);
    if (fresh.error) {
      setError(fresh.error);
      return false;
    }
    switch (action) {
      case "mintStable":
        return execute(() => sdk.simulateContract({ address: POOL, abi: poolAbi, functionName: "mintStable", args: [value, minOf(fresh.out), deadline()] }));
      case "mintLever":
        return execute(() => sdk.simulateContract({ address: POOL, abi: poolAbi, functionName: "mintLever", args: [value, minOf(fresh.out), deadline()] }));
      case "redeemStable":
        return execute(() => sdk.simulateContract({ address: POOL, abi: poolAbi, functionName: "redeemStable", args: [value, minOf(fresh.cOut), minOf(fresh.uOut)] }));
      case "redeemLever":
        return execute(() => sdk.simulateContract({ address: POOL, abi: poolAbi, functionName: "redeemLever", args: [value, minOf(fresh.cOut), minOf(fresh.uOut)] }));
      case "redeemPair":
        return execute(() => sdk.simulateContract({ address: POOL, abi: poolAbi, functionName: "redeemPair", args: [value, fresh.xMax ?? 0n, minOf(fresh.cOut), minOf(fresh.uOut)] }));
    }
  }

  async function guarded(actionId: string, run: () => Promise<boolean>, successKey: string) {
    if (busy) return;
    if (!account) {
      wallet.connect();
      return;
    }
    if (wrongNetwork) {
      setError(t("errors.switchNetwork"));
      return;
    }
    setError(null);
    setBusyAction(actionId);
    try {
      const ok = await run();
      if (ok) {
        setTxState("success");
        sdk.notify.success(t(successKey));
        setInput("");
      } else {
        setTxState("failed");
        setError((current) => current ?? t("errors.reverted"));
      }
    } catch (cause) {
      setTxState("failed");
      setError(describeError(cause));
    } finally {
      setBusyAction(null);
      scheduleReset();
      await reload();
    }
  }

  function submit() {
    if (!amount || disabledReason) return;
    const value = amount;
    if (tab === "insurance") {
      if (insuranceAction === "deposit") {
        void guarded("primary", async () => {
          if (!(await ensureAllowance(value))) return false;
          return execute(() => sdk.simulateContract({ address: STABILITY_POOL, abi: stabilityPoolAbi, functionName: "deposit", args: [value] }));
        }, "messages.depositSuccess");
      } else {
        void guarded("primary", () => execute(() => sdk.simulateContract({ address: STABILITY_POOL, abi: stabilityPoolAbi, functionName: "withdraw", args: [value] })), "messages.withdrawSuccess");
      }
      return;
    }
    const action = tab;
    void guarded("primary", async () => {
      if (action === "mintStable" || action === "mintLever") {
        // Quote first so a mint the pool would reject (stale price, leverage cap, breaker) never asks for an approval.
        const precheck = await fetchQuote(action, value);
        if (precheck.error) {
          setError(precheck.error);
          return false;
        }
        if (!(await ensureAllowance(value))) return false;
      }
      return runPoolAction(action, value);
    }, key("messages.", action + "Success"));
  }

  function claimGains() {
    void guarded("claim", () => execute(() => sdk.simulateContract({ address: STABILITY_POOL, abi: stabilityPoolAbi, functionName: "claimGains" })), "messages.claimSuccess");
  }

  function requestFaucet() {
    void guarded("faucet", () => execute(() => sdk.simulateContract({ address: TNVDA, abi: faucetAbi, functionName: "faucet" })), "messages.faucetSuccess");
  }

  const unavailable = t("states.unavailable");
  const faucetReadyAt = user?.lastFaucetAt && snapshot?.faucetCooldown ? Number(user.lastFaucetAt + snapshot.faucetCooldown) : 0;
  const faucetWait = faucetReadyAt > nowSec ? faucetReadyAt - nowSec : 0;
  const priceAge = state ? Number(state.priceAge) : null;

  const metrics = [
    { key: "poolValue", value: usdText(state?.V), hint: state ? t("hints.poolValue", undefined, { amount: amountText(state.C, 18, 3) ?? "", token: t("tokens.asset") }) : null, tone: "default" as const },
    { key: "stableSupply", value: amountText(state?.S, 18, 2), hint: t("hints.stableSupply"), tone: "success" as const },
    { key: "leverNav", value: usdText(state?.xNav, 4), hint: state ? t("hints.leverNav", undefined, { amount: amountText(state.X, 18, 2) ?? "" }) : null, tone: "primary" as const },
    { key: "leverage", value: leverageText(state?.leverage), hint: state ? t("hints.leverage", undefined, { low: leverageText(state.lowerTriggerLev) ?? "", high: leverageText(state.triggerLev) ?? "" }) : null, tone: "primary" as const },
    { key: "collateralRatio", value: ratioText(state?.collateralRatio), hint: t("hints.collateralRatio"), tone: state && state.collateralRatio < ONE ? ("warning" as const) : ("success" as const) },
    {
      key: "price",
      value: usdText(state?.price),
      hint: priceAge !== null ? t(state?.priceFresh ? "hints.priceFresh" : "hints.priceStale", undefined, { age: durationText(priceAge) }) : null,
      tone: state && !state.priceFresh ? ("warning" as const) : ("default" as const),
    },
  ];

  const feeBps = quote?.feeBps;
  const outputToken = tab === "mintStable" ? t("tokens.stable") : t("tokens.lever");
  const primaryLabel = !account
    ? t("actions.connect")
    : needsApproval && !overCap
      ? t("actions.approveAnd", undefined, { token: inputUnit, action: t(tab === "insurance" ? "actions.deposit" : key("tabs.", tab)) })
      : tab === "insurance"
        ? t(insuranceAction === "deposit" ? "actions.deposit" : "actions.withdraw")
        : t(key("tabs.", tab));

  return (
    <div className="min-h-screen w-full space-y-3 p-3 sm:space-y-4 sm:p-5">
      <Card className="overflow-hidden rounded-[18px] border-white/10 bg-gradient-to-b from-[#0e141d] to-[#070b11]">
        <CardHeader className="p-4 pb-3 sm:p-5 sm:pb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-[#D0FF00]" />
                <CardTitle className="text-base sm:text-lg">{t("title")}</CardTitle>
              </div>
              <p className="max-w-2xl text-sm font-medium leading-6 text-[#7c8899]">{t("subtitle")}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <StatusBadge tone={!modeKey ? "neutral" : modeKey === "normal" ? "success" : modeKey === "stability" ? "warning" : "danger"}>
                {modeKey ? t(key("modes.", modeKey)) : t("states.loading")}
              </StatusBadge>
              <StatusBadge tone={state?.marketOpen ? "success" : "neutral"}>
                {!state ? t("states.loading") : state.gapGuard ? t("market.gapGuard") : state.marketOpen ? t("market.open") : t("market.closed")}
              </StatusBadge>
              {state && (state.mintsPaused || state.feedHalted) ? <StatusBadge tone="danger">{state.feedHalted ? t("states.feedHalted") : t("states.mintsPaused")}</StatusBadge> : null}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3 p-4 pt-0 sm:space-y-4 sm:p-5 sm:pt-0">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 lg:gap-3">
            {metrics.map((item) => (
              <Metric key={item.key} label={t(key("metrics.", item.key))} value={item.value ?? unavailable} hint={item.hint ?? undefined} tone={item.tone} />
            ))}
          </div>

          {loadFailed ? <Alert tone="warning">{t("notices.readsUnavailable")}</Alert> : null}
          {state && !state.priceFresh ? <Alert tone="warning">{t("notices.priceStale")}</Alert> : null}
          {state && (state.mintsPaused || modeKey === "stability" || modeKey === "underwater") ? (
            <Alert tone="warning">{state.mintsPaused ? t("notices.mintsPaused") : modeKey === "stability" ? t("notices.stabilityMode") : t("notices.underwater")}</Alert>
          ) : null}
          {wrongNetwork ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[#FFD166]/40 bg-[#1A1305] p-3">
              <span className="text-sm font-medium text-[#FFD166]">{t("notices.wrongNetwork")}</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => void wallet.switchChain().catch(() => undefined)}>
                {t("actions.switchNetwork")}
              </Button>
            </div>
          ) : null}

          <div className="rounded-[14px] border border-white/10 bg-black/30 p-3 sm:p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#eaf1f8]">
              <Activity className="h-4 w-4 text-[#D0FF00]" />
              {t("sections.trade")}
            </div>
            <div className="mt-3 flex flex-wrap gap-2" role="tablist">
              {TABS.map((item) => (
                <Button
                  key={item}
                  type="button"
                  size="sm"
                  role="tab"
                  aria-selected={tab === item}
                  variant={tab === item ? "default" : "outline"}
                  onClick={() => {
                    setTab(item);
                    setInput("");
                    setError(null);
                  }}
                >
                  {t(key("tabs.", item))}
                </Button>
              ))}
            </div>

            <p className="mt-3 text-xs font-medium leading-5 text-[#7c8899]">{t(key("descriptions.", tab))}</p>

            {tab === "insurance" ? (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="min-w-0 rounded-[10px] border border-white/10 bg-[#0e141d] p-3">
                    <div className="truncate text-xs font-medium text-[#7c8899]">{t("insurance.total")}</div>
                    <div className="mt-1 truncate text-sm font-semibold text-[#eaf1f8]">{amountText(snapshot?.spTotal, 18, 2) ?? unavailable} {t("tokens.stable")}</div>
                  </div>
                  <div className="min-w-0 rounded-[10px] border border-white/10 bg-[#0e141d] p-3">
                    <div className="truncate text-xs font-medium text-[#7c8899]">{t("insurance.yourDeposit")}</div>
                    <div className="mt-1 truncate text-sm font-semibold text-[#eaf1f8]">{account ? `${amountText(user?.spDeposit, 18, 2) ?? unavailable} ${t("tokens.stable")}` : t("states.connectToSee")}</div>
                  </div>
                  <div className="min-w-0 rounded-[10px] border border-white/10 bg-[#0e141d] p-3">
                    <div className="truncate text-xs font-medium text-[#7c8899]">{t("insurance.gains")}</div>
                    <div className="mt-1 truncate text-sm font-semibold text-[#eaf1f8]">
                      {account
                        ? t("insurance.gainsValue", undefined, { asset: amountText(user?.spAssetGain, 18, 4) ?? "0", stable: amountText(user?.spStableReward, 18, 4) ?? "0" })
                        : t("states.connectToSee")}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(["deposit", "withdraw"] as InsuranceAction[]).map((item) => (
                    <Button
                      key={item}
                      type="button"
                      size="sm"
                      variant={insuranceAction === item ? "secondary" : "ghost"}
                      onClick={() => {
                        setInsuranceAction(item);
                        setInput("");
                        setError(null);
                      }}
                    >
                      {t(key("actions.", item))}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs font-medium text-[#7c8899]">
                <span>{t("labels.amount", undefined, { token: inputUnit })}</span>
                {balance !== null ? (
                  <button type="button" className="text-[#D4D4D4] hover:text-[#D0FF00]" onClick={() => setInput(formatUnits(balance, 18))}>
                    {t("labels.balanceMax", undefined, { amount: amountText(balance, 18, 4) ?? "0" })}
                  </button>
                ) : null}
              </div>
              <Input className="mt-1" inputMode="decimal" placeholder="0.0" value={input} aria-label={t("labels.amount", undefined, { token: inputUnit })} onChange={(event) => setInput(event.target.value)} />
            </div>

            <div className="mt-3 space-y-1.5 rounded-[10px] border border-white/10 bg-[#0B0D0E] p-3 text-xs">
              {tab !== "insurance" && quote && !quote.error ? (
                <>
                  {isMint ? (
                    <>
                      <div className="flex justify-between gap-3"><span className="text-[#84888C]">{t("quote.receive")}</span><span className="text-right text-white">{amountText(quote.out) ?? "-"} {outputToken}</span></div>
                      <div className="flex justify-between gap-3"><span className="text-[#84888C]">{t("quote.minimum")}</span><span className="text-right text-white">{amountText(minOf(quote.out)) ?? "-"} {outputToken}</span></div>
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between gap-3">
                        <span className="text-[#84888C]">{t("quote.receive")}</span>
                        <span className="text-right text-white">{t("quote.redeemOut", undefined, { asset: amountText(quote.cOut) ?? "0", usdc: amountText(quote.uOut, usdcDecimals, 2) ?? "0" })}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-[#84888C]">{t("quote.minimum")}</span>
                        <span className="text-right text-white">{t("quote.redeemOut", undefined, { asset: amountText(minOf(quote.cOut)) ?? "0", usdc: amountText(minOf(quote.uOut), usdcDecimals, 2) ?? "0" })}</span>
                      </div>
                      {tab === "redeemPair" ? (
                        <div className="flex justify-between gap-3">
                          <span className="text-[#84888C]">{t("quote.burns")}</span>
                          <span className="text-right text-white">{t("quote.burnsValue", undefined, { stable: amountText(quote.sBurned) ?? "0", lever: amountText(quote.xBurned) ?? "0" })}</span>
                        </div>
                      ) : null}
                    </>
                  )}
                  {feeBps !== undefined ? <div className="flex justify-between gap-3"><span className="text-[#84888C]">{t("quote.fee")}</span><span className="text-white">{formatPercentBps(feeBps)}</span></div> : null}
                  <div className="flex justify-between gap-3"><span className="text-[#84888C]">{t("quote.slippage")}</span><span className="text-white">{t("quote.slippageValue")}</span></div>
                </>
              ) : quote?.error ? (
                <div className="text-[#FF4A55]">{t("quote.blocked", undefined, { reason: quote.error })}</div>
              ) : (
                <div className="text-[#84888C]">
                  {tab === "insurance"
                    ? t("quote.insuranceHint")
                    : t("quote.feesNow", undefined, { stable: state ? formatPercentBps(state.stableMintFeeBps) : "-", lever: state ? formatPercentBps(state.leverMintFeeBps) : "-" })}
                </div>
              )}
              {needsApprovalFlow ? (
                <div className="flex justify-between gap-3 border-t border-white/10 pt-1.5">
                  <span className="text-[#84888C]">{t("quote.allowance", undefined, { spender: t(isDeposit ? "contracts.stabilityPool" : "contracts.pool") })}</span>
                  <span className="text-right text-white">
                    {account ? `${amountText(allowance) ?? unavailable} ${inputUnit}` : t("states.connectToSee")}
                  </span>
                </div>
              ) : null}
              {needsApprovalFlow ? <div className="text-[#84888C]">{t("quote.approvalNote", undefined, { cap: amountText(approvalCap, 18, 0) ?? "", token: inputUnit })}</div> : null}
              {tab === "mintStable" && snapshot?.maxMintStable !== null && snapshot?.maxMintStable !== undefined ? (
                <div className="text-[#84888C]">{t("quote.maxMintStable", undefined, { amount: amountText(snapshot.maxMintStable, 18, 4) ?? "0" })}</div>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <TxButton
                type="button"
                className="min-w-[180px] flex-1"
                state={busyAction === "primary" ? txState : "idle"}
                disabled={busy || (!!account && (wrongNetwork || !!disabledReason))}
                idleLabel={account && disabledReason ? disabledReason : primaryLabel}
                onClick={() => (account ? submit() : wallet.connect())}
              />
              {tab === "insurance" ? (
                <TxButton
                  type="button"
                  variant="outline"
                  state={busyAction === "claim" ? txState : "idle"}
                  disabled={busy || !account || wrongNetwork || !((user?.spAssetGain ?? 0n) > 0n || (user?.spStableReward ?? 0n) > 0n)}
                  idleLabel={t("actions.claim")}
                  onClick={claimGains}
                />
              ) : null}
            </div>
            {error ? <div className="mt-3"><Alert tone="danger">{error}</Alert></div> : null}
            {lastTx ? (
              <button type="button" className="mt-2 text-xs font-medium text-[#84888C] hover:text-[#D0FF00]" onClick={() => sdk.openExplorerTx(lastTx)}>
                {t("labels.viewTx")}
              </button>
            ) : null}
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-[14px] border border-white/10 bg-black/25 p-3 sm:p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#eaf1f8]">
                <Wallet className="h-4 w-4 text-[#2EDEDB]" />
                {t("sections.wallet")}
              </div>
              {account ? (
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {[
                    ["tokens.asset", amountText(user?.asset)],
                    ["tokens.stable", amountText(user?.sUSD)],
                    ["tokens.lever", amountText(user?.x)],
                    ["tokens.usdc", amountText(user?.usdc, usdcDecimals, 2)],
                  ].map(([key, value]) => (
                    <div key={key} className="flex min-w-0 justify-between gap-2">
                      <span className="text-[#84888C]">{t(key ?? "")}</span>
                      <span className="truncate text-white">{value ?? unavailable}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs font-medium leading-5 text-[#7c8899]">{t("states.walletRequired")}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
                <div className="flex min-w-0 items-center gap-2 text-xs text-[#7c8899]">
                  <Droplets className="h-4 w-4 shrink-0 text-[#D0FF00]" />
                  <span>{t("faucet.hint", undefined, { amount: amountText(snapshot?.faucetAmount, 18, 0) ?? "-", cooldown: snapshot?.faucetCooldown ? durationText(Number(snapshot.faucetCooldown)) : "-" })}</span>
                </div>
                <TxButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  state={busyAction === "faucet" ? txState : "idle"}
                  disabled={busy || !account || wrongNetwork || faucetWait > 0}
                  idleLabel={faucetWait > 0 ? t("faucet.wait", undefined, { time: durationText(faucetWait) }) : t("faucet.action")}
                  onClick={requestFaucet}
                />
              </div>
            </div>

            <div className="rounded-[14px] border border-white/10 bg-black/25 p-3 sm:p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#eaf1f8]">
                <ShieldCheck className="h-4 w-4 text-[#2EDEDB]" />
                {t("sections.contracts")}
              </div>
              <div className="mt-2 space-y-1 text-xs">
                {(
                  [
                    ["contracts.pool", POOL],
                    ["contracts.stabilityPool", STABILITY_POOL],
                    ["contracts.asset", TNVDA],
                    ["contracts.stable", SUSD],
                    ["contracts.lever", poolTokens?.lever],
                  ] as [string, string | undefined][]
                ).map(([labelKey, address]) => (
                  <div key={labelKey} className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-[#84888C]">{t(labelKey)}</span>
                    <AddressLink address={address} />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-4 text-[#7c8899]">{t("notices.network")}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
