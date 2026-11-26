"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { bscTestnet } from "viem/chains";
import { formatEther, parseEther, zeroAddress, type Address } from "viem";
import { useAccount, useBalance, useReadContract, useReadContracts } from "wagmi";
import { BackstopVaultAbi, FlapTaxProcessorAbi, FlapTaxTokenAbi, SplitLauncherAbi, erc20Abi } from "@/abi";
import { addr, deployments97, TESTNET_EXTERNAL } from "@/config/deployments";
import { addressUrl, tokenUrl } from "@/config/chains";
import { useNow } from "@/hooks/usePools";
import { useTx } from "@/hooks/useTx";
import { fmtDuration, fmtNum, fmtTime, fmtUsd, short } from "@/lib/format";
import { Addr, Card, Empty, KV, PageHeader, Stat } from "@/components/ui";

const FLAP_TOKEN_URL = process.env.NEXT_PUBLIC_FLAP_TOKEN_URL_PREFIX; // optional, e.g. the Flap testnet token page prefix

const VIEWS = [
  "raised", "targetRaise", "remaining", "saleDeadline", "backstopSeed", "launched", "launching", "failed", "poolOpened", "pool", "token",
  "predictedToken", "creator", "backstopVault", "backstopBufferUsd", "boostToken", "boostAmount", "name", "symbol", "xLocked", "launchedAt", "lpPair",
] as const;
type ViewName = (typeof VIEWS)[number];

export default function LaunchPage() {
  const entry = deployments97.flap.launchers[0];
  const launcher = addr(entry?.launcher);
  if (!launcher) {
    return (
      <>
        <PageHeader title="SPLIT crowdfund (Flap)" lede="A backstop-first crowdfund: the raise launches a …7777 tax token on Flap, and the rest opens the NVDA SplitStock pool with protocol-owned first-loss xNVDA." />
        <Empty>The SplitLauncher is not deployed yet (deployments/97.json flap.launchers[]). Factory: {deployments97.flap.launcherFactory ? <Addr a={deployments97.flap.launcherFactory} /> : "pending"}.</Empty>
        <HowItWorks />
      </>
    );
  }
  return <LaunchView launcher={launcher} taxProcessor={addr(entry?.taxProcessor)} />;
}

function HowItWorks() {
  return (
    <div className="mt-5 grid gap-3 md:grid-cols-4">
      {[
        ["Contribute", "Send tBNB until the target is hit. The contribution that fills the target launches the token; remaining() tells you the exact last amount."],
        ["Boost", "Escrow 100 sUSD from any SplitStock pool for 1.2× weight (one per address). It comes back on claim or refund."],
        ["openPool()", "Anyone, once: PoolFactory.createPool(tNVDA, NVDA mirror), swap the backstop seed to tNVDA, seed() the pool. That first-loss xNVDA is locked in the BackstopVault."],
        ["Tax → backstop", "3% buy/sell tax: VAULT 50% to the BackstopVault, LP 20%, burn 30%. dispatch() moves it; cover() spends it only while CR < 1."],
      ].map(([t, b]) => (
        <div key={t} className="card">
          <div className="text-sm font-semibold text-ink">{t}</div>
          <div className="mt-1 text-xs text-muted">{b}</div>
        </div>
      ))}
    </div>
  );
}

function LaunchView({ launcher, taxProcessor: taxFromDeployments }: { launcher: Address; taxProcessor?: Address }) {
  const { address } = useAccount();
  const now = useNow(1000);
  const { send, pending } = useTx();
  const [amt, setAmt] = useState("");
  const [touched, setTouched] = useState(false);
  const u = address ?? zeroAddress;
  const reads = useReadContracts({
    allowFailure: true,
    query: { refetchInterval: 10_000 },
    contracts: [
      ...VIEWS.map((fn) => ({ address: launcher, abi: SplitLauncherAbi, functionName: fn, chainId: bscTestnet.id })),
      { address: launcher, abi: SplitLauncherAbi, functionName: "contributions", args: [u], chainId: bscTestnet.id },
      { address: launcher, abi: SplitLauncherAbi, functionName: "claimable", args: [u], chainId: bscTestnet.id },
      { address: launcher, abi: SplitLauncherAbi, functionName: "boosted", args: [u], chainId: bscTestnet.id },
      { address: launcher, abi: SplitLauncherAbi, functionName: "claimed", args: [u], chainId: bscTestnet.id },
      { address: launcher, abi: SplitLauncherAbi, functionName: "refunded", args: [u], chainId: bscTestnet.id },
    ] as never[],
  });
  const r = reads.data ?? [];
  const v = <T,>(name: ViewName): T | undefined => {
    const x = r[VIEWS.indexOf(name)];
    return x?.status === "success" ? (x.result as T) : undefined;
  };
  const userAt = <T,>(i: number): T | undefined => {
    const x = r[VIEWS.length + i];
    return x?.status === "success" ? (x.result as T) : undefined;
  };
  const raised = v<bigint>("raised") ?? 0n;
  const target = v<bigint>("targetRaise") ?? 0n;
  const remaining = v<bigint>("remaining") ?? (target > raised ? target - raised : 0n);
  const deadline = Number(v<bigint>("saleDeadline") ?? 0n);
  const launched = v<boolean>("launched") ?? false;
  const failed = v<boolean>("failed") ?? false;
  const poolOpened = v<boolean>("poolOpened") ?? false;
  const token = v<Address>("token");
  const vault = v<Address>("backstopVault");
  const boostToken = v<Address>("boostToken");
  const boostAmount = v<bigint>("boostAmount") ?? 100n * 10n ** 18n;
  const pct = target > 0n ? Number((raised * 10_000n) / target) / 100 : 0;
  const myContribution = userAt<bigint>(0) ?? 0n;
  const myClaimable = userAt<bigint>(1) ?? 0n;
  const myBoosted = userAt<boolean>(2) ?? false;
  const myClaimed = userAt<boolean>(3) ?? false;
  const myRefunded = userAt<boolean>(4) ?? false;
  const open = !launched && !failed && deadline > now;
  // Prefill the exact remaining amount (the last contribution fills the target and launches), until the user types.
  useEffect(() => {
    if (!touched && open && remaining > 0n) setAmt(formatEther(remaining));
  }, [touched, open, remaining]);

  const extra = useReadContracts({
    allowFailure: true,
    query: { refetchInterval: 15_000, enabled: !!boostToken || !!vault },
    contracts: [
      boostToken && address ? { address: boostToken, abi: erc20Abi, functionName: "allowance", args: [address, launcher], chainId: bscTestnet.id } : { address: launcher, abi: SplitLauncherAbi, functionName: "raised", chainId: bscTestnet.id },
      boostToken && address ? { address: boostToken, abi: erc20Abi, functionName: "balanceOf", args: [address], chainId: bscTestnet.id } : { address: launcher, abi: SplitLauncherAbi, functionName: "raised", chainId: bscTestnet.id },
      vault ? { address: vault, abi: BackstopVaultAbi, functionName: "bufferBnb", chainId: bscTestnet.id } : { address: launcher, abi: SplitLauncherAbi, functionName: "raised", chainId: bscTestnet.id },
      vault ? { address: vault, abi: BackstopVaultAbi, functionName: "totalRevenue", chainId: bscTestnet.id } : { address: launcher, abi: SplitLauncherAbi, functionName: "raised", chainId: bscTestnet.id },
      vault ? { address: vault, abi: BackstopVaultAbi, functionName: "xHeld", chainId: bscTestnet.id } : { address: launcher, abi: SplitLauncherAbi, functionName: "raised", chainId: bscTestnet.id },
    ] as never[],
  });
  const ex = (i: number) => (extra.data?.[i]?.status === "success" ? (extra.data[i].result as bigint) : undefined);
  const boostAllowance = boostToken && address ? ex(0) : undefined;
  const boostBalance = boostToken && address ? ex(1) : undefined;
  const bal = useBalance({ address, chainId: bscTestnet.id, query: { enabled: !!address } });
  const tp = useReadContract({ address: token, abi: FlapTaxTokenAbi, functionName: "taxProcessor", chainId: bscTestnet.id, query: { enabled: !taxFromDeployments && !!token && token !== zeroAddress } });
  const taxProcessor = taxFromDeployments ?? (tp.data && tp.data !== zeroAddress ? tp.data : undefined);

  let value: bigint | undefined;
  try {
    value = amt ? parseEther(amt) : undefined;
  } catch {
    value = undefined;
  }
  const over = value !== undefined && remaining > 0n && value > remaining;
  const poolAddr = v<Address>("pool");
  const hasPool = !!poolAddr && poolAddr !== zeroAddress;
  const opened = poolOpened || hasPool;
  const lpPair = v<Address>("lpPair");
  const graduated = launched && !!lpPair && lpPair !== zeroAddress;
  const hasToken = !!token && token !== zeroAddress;
  const phase: "open" | "launched" | "opened" | "failed" | "closed" = opened ? "opened" : launched ? "launched" : failed ? "failed" : open ? "open" : "closed";

  const steps = [
    { label: "Crowdfund fills", done: launched, active: phase === "open" },
    { label: "7777 token launches and graduates on Flap", done: launched, active: false },
    { label: "Open pool: NVDA pool is created", done: opened, active: phase === "launched" },
  ];

  return (
    <>
      <PageHeader
        title={`${v<string>("name") ?? "SPLIT"} crowdfund on Flap`}
        lede="When the crowdfund fills, it launches a tax token on Flap, and the raise becomes the first-loss capital of a new NVDA pool. Half of the token's trading tax funds a vault that protects that pool."
        right={
          <span className={`pill ${phase === "opened" || phase === "launched" ? "border-good/40 text-good" : phase === "failed" ? "border-bad/40 text-bad" : ""}`}>
            {phase === "opened" ? "Pool open" : phase === "launched" ? "Launched · pool not opened" : phase === "failed" ? "Failed: refunds open" : phase === "open" ? `Open · ${fmtDuration(deadline - now)} left` : "Closed"}
          </span>
        }
      />

      <ol className="mb-5 grid gap-2 sm:grid-cols-3">
        {steps.map((st, i) => (
          <li key={st.label} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${st.done ? "border-good/40 bg-good/5" : st.active ? "border-stable/50 bg-stable-soft/40" : "border-line"}`}>
            <span className={`num flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${st.done ? "bg-good text-white" : st.active ? "bg-stable text-white" : "bg-surface2 text-muted"}`}>{st.done ? "✓" : i + 1}</span>
            <span className={st.done || st.active ? "text-ink" : "text-muted"}>{st.label}</span>
          </li>
        ))}
      </ol>

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card title="Crowdfund" right={<span className="num text-xs text-muted">{pct.toFixed(1)}% filled</span>}>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Raised" value={`${fmtNum(Number(formatEther(raised)))} tBNB`} />
              <Stat label="Target" value={`${fmtNum(Number(formatEther(target)))} tBNB`} />
              <Stat label="Remaining" value={`${fmtNum(Number(formatEther(remaining)))} tBNB`} tone={launched ? "good" : "lever"} />
              <Stat label="Deadline" value={deadline ? (launched ? "Filled" : deadline > now ? fmtDuration(deadline - now) : "Passed") : "–"} sub={deadline ? fmtTime(deadline) : undefined} />
            </div>
            <div className="mt-4 h-3 overflow-hidden rounded-full bg-surface2">
              <div className="h-full bg-lever transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <div className="num mt-1 flex justify-between text-xs text-muted">
              <span>Backstop seed {fmtNum(Number(formatEther(v<bigint>("backstopSeed") ?? 0n)))} tBNB → first-loss xNVDA</span>
              <span>{fmtNum(Number(formatEther(raised)))} / {fmtNum(Number(formatEther(target)))} tBNB</span>
            </div>
          </Card>

          <Card
            title="Token and pool"
            right={
              <span className="flex gap-1.5">
                {launched && <span className="pill border-good/40 text-good">Launched</span>}
                {graduated && <span className="pill border-good/40 text-good">Graduated on Flap</span>}
                {opened && <span className="pill border-stable/40 text-stable">NVDA pool open</span>}
              </span>
            }
          >
            <div className="grid gap-x-6 sm:grid-cols-2">
              <KV
                k="Token (…7777)"
                v={hasToken ? <a className="link num" href={tokenUrl(token!)} target="_blank" rel="noreferrer">{short(token)}</a> : <span className="text-faint">predicted {short(v<Address>("predictedToken"))}</span>}
              />
              <KV k="Flap LP pair" v={graduated ? <Addr a={lpPair} /> : "–"} />
              <KV k="BackstopVault" v={<Addr a={vault && vault !== zeroAddress ? vault : undefined} />} />
              <KV k="Vault buffer" v={v<bigint>("backstopBufferUsd") !== undefined ? fmtUsd(Number(v<bigint>("backstopBufferUsd")) / 1e18) : "–"} />
              <KV k="Vault tBNB" v={ex(2) !== undefined ? fmtNum(Number(formatEther(ex(2)!))) : "–"} />
              <KV k="Tax received (all time)" v={ex(3) !== undefined ? `${fmtNum(Number(formatEther(ex(3)!)))} tBNB` : "–"} />
              <KV k="First-loss xNVDA locked" v={ex(4) !== undefined ? fmtNum(Number(ex(4)) / 1e18) : v<bigint>("xLocked") !== undefined ? fmtNum(Number(v<bigint>("xLocked")) / 1e18) : "–"} />
              <KV k="NVDA pool" v={hasPool ? <Link className="link" href="/pools/nvda-flap">{short(poolAddr)} →</Link> : "not opened"} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {hasToken && FLAP_TOKEN_URL && (
                <a className="btn btn-sm" href={`${FLAP_TOKEN_URL}${token}`} target="_blank" rel="noreferrer">View on Flap ↗</a>
              )}
              {hasToken && <a className="btn btn-sm" href={tokenUrl(token!)} target="_blank" rel="noreferrer">Token on BscScan ↗</a>}
              <a className="btn btn-sm" href={addressUrl(deployments97.flap.portal ?? TESTNET_EXTERNAL.flapPortal)} target="_blank" rel="noreferrer">Flap Portal ↗</a>
              {taxProcessor && (
                <button className="btn btn-sm" disabled={!launched || !!pending} onClick={() => send({ address: taxProcessor, abi: FlapTaxProcessorAbi, functionName: "dispatch", label: "TaxProcessor.dispatch()" })}>
                  Dispatch tax to vault
                </button>
              )}
            </div>
            <p className="mt-2 text-[11px] text-faint">The token trades on Flap&apos;s V2 router. Open pool is a separate call, so a pool-side failure can never revert the Flap launch.</p>
          </Card>
          <HowItWorks />
        </div>

        <div className="space-y-5">
          {phase === "opened" ? (
            <Card title="NVDA pool is open">
              <p className="text-sm text-muted">The raise is now the first-loss xNVDA of a new SplitStock pool, locked in the BackstopVault. The vault is the pool&apos;s donor.</p>
              <Link href="/pools/nvda-flap" className="btn-stable mt-4 w-full">
                View NVDA pool →
              </Link>
            </Card>
          ) : phase === "launched" ? (
            <Card title="Open the NVDA pool">
              <p className="text-sm text-muted">The token launched. One permissionless call creates the NVDA pool, swaps the backstop seed to tNVDA and seeds the pool with first-loss xNVDA.</p>
              <button
                className="btn-primary mt-4 w-full text-base"
                disabled={!!pending}
                onClick={async () => {
                  await send({ address: launcher, abi: SplitLauncherAbi, functionName: "openPool", label: "Open pool" });
                  void reads.refetch();
                }}
              >
                {pending === "Open pool" ? "Opening pool…" : "Open pool"}
              </button>
            </Card>
          ) : (
            <Card title="Contribute">
              <div className="flex items-baseline justify-between text-xs text-muted">
                <span>Amount (tBNB)</span>
                <button className="num hover:text-ink" onClick={() => { setTouched(false); setAmt(formatEther(remaining)); }}>
                  Remaining {fmtNum(Number(formatEther(remaining)))}
                </button>
              </div>
              <input className="input mt-1" inputMode="decimal" placeholder="0.1" value={amt} onChange={(e) => { setTouched(true); setAmt(e.target.value); }} />
              {bal.data && <div className="num mt-1 text-xs text-faint">Wallet {fmtNum(Number(formatEther(bal.data.value)))} tBNB</div>}
              {over && <div className="mt-1 text-xs text-muted">Above the remaining amount: the launcher takes {fmtNum(Number(formatEther(remaining)))} tBNB and sends the rest back.</div>}
              <button
                className="btn-lever mt-3 w-full"
                disabled={!open || !value || value === 0n || !!pending}
                onClick={async () => {
                  await send({ address: launcher, abi: SplitLauncherAbi, functionName: "contribute", value, label: value !== undefined && value >= remaining ? "Contribute and launch" : "Contribute" });
                  setTouched(false);
                  void reads.refetch();
                }}
              >
                {pending ? `${pending}…` : !open ? (failed ? "Sale failed" : "Sale closed") : value !== undefined && remaining > 0n && value >= remaining ? "Contribute and launch" : "Contribute"}
              </button>
              <p className="mt-2 text-[11px] text-faint">The contribution that fills the target launches the token on Flap in the same transaction.</p>
              {boostToken && boostToken !== zeroAddress && (
                <div className="mt-4 border-t border-line pt-3">
                  <div className="text-xs text-muted">
                    Boost: escrow {fmtNum(Number(boostAmount) / 1e18)} sUSD for 1.2× weight {myBoosted ? "(already boosted)" : ""}. Your sUSD: {boostBalance !== undefined ? fmtNum(Number(boostBalance) / 1e18) : "–"}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button className="btn btn-sm" disabled={!!pending || myBoosted || (boostAllowance ?? 0n) >= boostAmount} onClick={() => send({ address: boostToken, abi: erc20Abi, functionName: "approve", args: [launcher, boostAmount], label: "Approve sUSD escrow" }).then(() => extra.refetch())}>
                      1. Approve sUSD
                    </button>
                    <button className="btn-stable btn-sm" disabled={!open || !value || myBoosted || (boostAllowance ?? 0n) < boostAmount || !!pending} onClick={() => send({ address: launcher, abi: SplitLauncherAbi, functionName: "contributeBoosted", value, label: "Contribute (boosted)" }).then(() => reads.refetch())}>
                      2. Contribute boosted
                    </button>
                  </div>
                </div>
              )}
            </Card>
          )}
          <Card title="Your position">
            <KV k="Contributed" v={`${fmtNum(Number(formatEther(myContribution)))} tBNB`} />
            <KV k="Claimable" v={`${fmtNum(Number(myClaimable) / 1e18)} ${v<string>("symbol") ?? "SPLIT"}`} />
            <KV k="Boosted" v={myBoosted ? "yes (1.2×)" : "no"} />
            <div className="mt-3 flex gap-2">
              <button className="btn-primary btn-sm" disabled={!launched || myClaimed || myClaimable === 0n || !!pending} onClick={() => send({ address: launcher, abi: SplitLauncherAbi, functionName: "claim", label: "Claim tokens" }).then(() => reads.refetch())}>
                {myClaimed ? "Claimed" : "Claim"}
              </button>
              <button className="btn btn-sm" disabled={!failed || myRefunded || myContribution === 0n || !!pending} onClick={() => send({ address: launcher, abi: SplitLauncherAbi, functionName: "refund", label: "Refund" }).then(() => reads.refetch())}>
                {myRefunded ? "Refunded" : "Refund"}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-faint">Refunds open only if the sale fails (deadline passed before the target). Claim and refund are one-shot and exclusive.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
