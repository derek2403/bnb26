"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, VaultComponentProps } from "@/src/sdk";
import { ZERO_ADDRESS, formatTokenAmount, handleTxError, isActionAvailableForPhase, readTaxVaultHostContext, useFlapSdk } from "@/src/sdk";
import { Activity, ShieldCheck, ShieldAlert, Wallet } from "lucide-react";
import { AddressLink, Alert, Card, CardContent, CardHeader, CardTitle, DetailTile, Metric, StatusBadge, TxButton } from "@/src/ui";
import type { TxButtonState } from "@/src/ui";
import { vaultAbi } from "./VaultABI";

// SplitStock BackstopVault panel: buffer USD (Atlas BNB/USD), defended pool CR, total defended, permissionless cover(pool).
// Every read and the write target context.vaultAddress only; the defended pool address comes from the vault itself.

const one = 10n ** 18n;

interface VaultSnapshot {
  bufferUsd: bigint | null;
  pool: Address | null;
  collateralRatio: bigint | null;
  totalDefendedUsd: bigint | null;
  canCover: boolean | null;
}

function settled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

function usd(value: bigint | null) {
  return value === null ? null : "$" + formatTokenAmount(value, 18, 2);
}

function percent(value: bigint | null) {
  return value === null ? null : formatTokenAmount(value * 100n, 18, 2) + "%";
}

export default function SplitstockBackstopVault(_props: VaultComponentProps) {
  const sdk = useFlapSdk();
  const { context, i18n } = sdk;
  const t = i18n.t;
  const host = readTaxVaultHostContext(context.host);
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxButtonState>("idle");
  const resetTimer = useRef<number | null>(null);

  const marketPhase = host.marketPhase;
  const marketPhaseLabel =
    marketPhase === "internal-market"
      ? t("states.marketPhaseInternal")
      : marketPhase === "dex-listed"
        ? t("states.marketPhaseDexListed")
        : t("states.marketPhaseUnknown");
  const riskLevel = host.vaultInfo?.riskLevel ?? host.taxInfo?.vaultInfo?.riskLevel ?? null;
  const riskLabel =
    riskLevel === 1
      ? t("states.riskLow")
      : riskLevel === 2
        ? t("states.riskLowMedium")
        : riskLevel === 3
          ? t("states.riskMedium")
          : riskLevel === 4
            ? t("states.riskHigh")
            : riskLevel === 0
              ? t("states.riskUnverified")
              : t("states.riskMissing");
  const riskTone = riskLevel === null || riskLevel === 0 || riskLevel >= 4 ? "danger" : riskLevel >= 3 ? "warning" : "success";

  const loadData = useCallback(async () => {
    const read = <T,>(functionName: "bufferUsd" | "pool" | "poolCollateralRatio" | "totalDefendedUsd") =>
      sdk.readContract<T>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName });
    const results = await Promise.allSettled([
      read<bigint>("bufferUsd"),
      read<Address>("pool"),
      read<bigint>("poolCollateralRatio"),
      read<bigint>("totalDefendedUsd"),
    ]);
    const pool = settled(results[1]);
    const livePool = pool && pool !== ZERO_ADDRESS ? pool : null;
    // U-01: ask the vault itself whether cover would pass (buffer, price freshness, CR < 1, epoch caps).
    let coverable: boolean | null = null;
    if (livePool) {
      try {
        coverable = await sdk.readContract<boolean>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "canCover", args: [livePool] });
      } catch {
        coverable = null;
      }
    }
    setSnapshot({
      canCover: coverable,
      bufferUsd: settled(results[0]),
      pool: pool && pool !== ZERO_ADDRESS ? pool : null,
      collateralRatio: settled(results[2]),
      totalDefendedUsd: settled(results[3]),
    });
    setLoadFailed(results.every((result) => result.status === "rejected"));
  }, [context.vaultAddress, sdk]);

  useEffect(() => {
    void loadData().catch(() => setLoadFailed(true));
    const timer = window.setInterval(() => {
      void loadData().catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadData, sdk.refetchNonce]);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const pool = snapshot?.pool ?? null;
  const ratio = snapshot?.collateralRatio ?? null;
  const coverable = snapshot?.canCover ?? null;
  // A ratio of 0 means the vault could not read pool.state(); treat it as unavailable, not as under water.
  const ratioKnown = ratio !== null && ratio > 0n;
  const underwater = ratioKnown && ratio < one;
  const writesAvailable = isActionAvailableForPhase("both", marketPhase);
  const wrongNetwork = sdk.wallet.isWrongNetwork;
  const busy = !["idle", "success", "failed"].includes(txState);

  const coverReason = !context.userAddress
    ? t("errors.connectWallet")
    : wrongNetwork
      ? t("errors.switchNetwork")
      : !writesAvailable
        ? t("errors.stageUnavailable")
        : !pool
          ? t("errors.noPool")
          : !ratioKnown
            ? t("errors.ratioUnavailable")
            : !underwater
              ? t("errors.poolHealthy")
              : coverable !== true
                ? t("errors.cannotCover")
                : null;

  async function handleCover() {
    if (coverReason || !pool || busy) {
      if (coverReason) setError(coverReason);
      return;
    }
    setError(null);
    try {
      setTxState("simulating");
      const simulation = await sdk.simulateContract({
        contract: "vault",
        address: context.vaultAddress,
        abi: vaultAbi,
        functionName: "cover",
        args: [pool],
      });
      setTxState("writing");
      const hash = await sdk.writeContract(simulation.request);
      setTxState("confirming");
      await sdk.waitForTx(hash);
      setTxState("success");
      sdk.notify.success(t("messages.coverSuccess"));
      await loadData();
    } catch (nextError) {
      setTxState("failed");
      setError(handleTxError(nextError, { reverted: t("errors.txFailed"), unknown: t("errors.txFailed") }));
    } finally {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => {
        resetTimer.current = null;
        setTxState("idle");
      }, 300);
    }
  }

  const unavailable = t("states.unavailable");

  return (
    <div className="w-full space-y-3 sm:space-y-4">
      <Card className="overflow-hidden rounded-[18px] border-white/10 bg-gradient-to-b from-[#0e141d] to-[#070b11]">
        <CardHeader className="p-4 pb-3 sm:p-5 sm:pb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-[#f3b33d]" />
                <CardTitle className="text-base sm:text-lg">{t("title")}</CardTitle>
              </div>
              <p className="max-w-2xl text-sm font-medium leading-6 text-[#7c8899]">{t("subtitle")}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <StatusBadge tone={riskTone}>{riskLabel}</StatusBadge>
              <StatusBadge tone="neutral">{marketPhaseLabel}</StatusBadge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0 sm:space-y-4 sm:p-5 sm:pt-0">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 lg:gap-3">
            <Metric label={t("labels.riskStatus")} value={riskLabel} hint={t("labels.hostRisk")} tone={riskTone === "success" ? "success" : "warning"} />
            <Metric label={t("labels.bufferUsd")} value={usd(snapshot?.bufferUsd ?? null) ?? unavailable} hint={t("hints.bufferUsd")} tone="primary" />
            <Metric
              label={t("labels.poolCr")}
              value={ratioKnown ? (percent(ratio) ?? unavailable) : unavailable}
              hint={ratio === null ? t("hints.poolCr") : underwater ? t("states.underwater") : t("states.healthy")}
              tone={ratio === null ? "default" : underwater ? "warning" : "success"}
            />
            <Metric label={t("labels.totalDefended")} value={usd(snapshot?.totalDefendedUsd ?? null) ?? unavailable} hint={t("hints.totalDefended")} />
          </div>

          {riskLevel === null ? <Alert tone="danger">{t("notices.riskMissing")}</Alert> : null}
          {loadFailed ? <Alert tone="warning">{t("notices.readsUnavailable")}</Alert> : null}

          <div className="rounded-[14px] border border-white/10 bg-black/25 p-3 sm:p-4">
            <div className="text-sm font-semibold text-[#eaf1f8]">{t("sections.mechanism")}</div>
            <p className="mt-2 text-xs font-medium leading-5 text-[#7c8899] sm:text-sm sm:leading-6">{t("flow.description")}</p>
          </div>

          <div className="grid grid-cols-1 overflow-hidden rounded-[14px] border border-white/10 sm:grid-cols-3">
            <div className="min-w-0 bg-[#0e141d] p-3">
              <div className="truncate text-xs font-medium text-[#7c8899]">{t("labels.vault")}</div>
              <div className="mt-2 min-w-0 text-sm font-semibold text-[#eaf1f8]">
                <AddressLink address={context.vaultAddress} explorerBaseUrl={context.explorerBaseUrl} />
              </div>
            </div>
            <div className="min-w-0 border-t border-white/10 bg-[#0e141d] p-3 sm:border-l sm:border-t-0">
              <div className="truncate text-xs font-medium text-[#7c8899]">{t("labels.token")}</div>
              <div className="mt-2 min-w-0 text-sm font-semibold text-[#eaf1f8]">
                <AddressLink address={context.tokenAddress} explorerBaseUrl={context.explorerBaseUrl} label={context.tokenSymbol} />
              </div>
            </div>
            <div className="min-w-0 border-t border-white/10 bg-[#0e141d] p-3 sm:border-l sm:border-t-0">
              <div className="truncate text-xs font-medium text-[#7c8899]">{t("labels.pool")}</div>
              <div className="mt-2 min-w-0 text-sm font-semibold text-[#eaf1f8]">
                {pool ? <AddressLink address={pool} explorerBaseUrl={context.explorerBaseUrl} /> : t("states.poolNotOpened")}
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <DetailTile
              icon={underwater ? <ShieldAlert className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
              label={t("labels.coverState")}
              value={!pool ? t("states.poolNotOpened") : !ratioKnown ? unavailable : !underwater ? t("states.coverClosed") : coverable === true ? t("states.coverOpen") : t("states.coverBlocked")}
              detail={t("hints.coverState")}
              tone={underwater ? "warning" : "muted"}
            />
            <DetailTile
              icon={<Wallet className="h-4 w-4" />}
              label={t("labels.walletState")}
              value={context.userAddress ? t("states.walletConnected") : t("states.walletRequired")}
              detail={t("hints.walletState")}
              tone={context.userAddress ? "success" : "warning"}
            />
          </div>

          <div className="rounded-[14px] border border-white/10 bg-black/30 p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#eaf1f8]">
                  <Activity className="h-4 w-4 text-[#f3b33d]" />
                  {t("sections.primaryAction")}
                </div>
                <p className="mt-1 text-xs font-medium leading-5 text-[#7c8899]">{coverReason ?? t("hints.cover")}</p>
              </div>
              {wrongNetwork && context.userAddress ? (
                <TxButton type="button" variant="secondary" idleLabel={t("actions.switchNetwork")} onClick={() => void sdk.wallet.switchChain()} />
              ) : (
                <TxButton type="button" state={txState} disabled={!!coverReason || busy} idleLabel={t("actions.cover")} onClick={() => void handleCover()} />
              )}
            </div>
            {error ? <div className="mt-3"><Alert tone="danger">{error}</Alert></div> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
