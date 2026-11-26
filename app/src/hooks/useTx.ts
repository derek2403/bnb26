"use client";
import { useCallback, useState } from "react";
import { BaseError, ContractFunctionRevertedError, parseEventLogs, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { bscTestnet } from "viem/chains";
import { useAccount, useConfig } from "wagmi";
import { simulateContract, switchChain, waitForTransactionReceipt, writeContract, sendTransaction, call } from "wagmi/actions";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { DecodeAbi } from "@/abi";
import { useToast } from "@/components/Toaster";
import { txUrl } from "@/config/chains";
import { explainError } from "@/lib/errors";

export type ContractCall = {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  /** Short human label for toasts, e.g. "Mint sUSD-NVDA". */
  label: string;
};

function stringifyArg(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return `[${v.map(stringifyArg).join(", ")}]`;
  if (v && typeof v === "object") return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  return String(v);
}

/** Human text for a failed simulate/write: decoded custom error name and args when available. */
export function describeError(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) {
      const name = rev.data?.errorName ?? rev.reason ?? "reverted";
      const args = rev.data?.args?.length ? `(${rev.data.args.map(stringifyArg).join(", ")})` : "";
      const why = rev.data?.errorName ? explainError(rev.data.errorName, rev.data.args ?? []) : undefined;
      return why ? `${why} [${name}${args}]` : `${name}${args}`;
    }
    if (/user rejected|denied transaction/i.test(e.message)) return "You rejected the request in your wallet.";
    return e.shortMessage || e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function decodeReceipt(receipt: TransactionReceipt): string[] {
  try {
    const events = parseEventLogs({ abi: DecodeAbi, logs: receipt.logs, strict: false });
    return events
      .filter((ev) => ev.eventName && !["Transfer", "Approval"].includes(ev.eventName))
      .map((ev) => {
        const args = ev.args && typeof ev.args === "object" ? Object.entries(ev.args as Record<string, unknown>).filter(([k]) => Number.isNaN(Number(k))) : [];
        const body = args
          .slice(0, 5)
          .map(([k, v]) => `${k}=${stringifyArg(v).slice(0, 24)}`)
          .join(" ");
        return `${ev.eventName} ${body}`.trim();
      });
  } catch {
    return [];
  }
}

/** simulateContract -> writeContract -> waitForTransactionReceipt -> decoded-event toast with a BscScan link. */
export function useTx() {
  const config = useConfig();
  const { address, chainId, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);

  const ensure = useCallback(async () => {
    if (!isConnected || !address) {
      openConnectModal?.();
      throw new Error("Connect a wallet first");
    }
    if (chainId !== bscTestnet.id) await switchChain(config, { chainId: bscTestnet.id });
    return address;
  }, [isConnected, address, chainId, config, openConnectModal]);

  const send = useCallback(
    async (c: ContractCall): Promise<TransactionReceipt | null> => {
      let id: number | null = null;
      setPending(c.label);
      try {
        const account = await ensure();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { request } = await simulateContract(config, { ...(c as any), account, chainId: bscTestnet.id });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hash = await writeContract(config, request as any);
        id = toast.push({ kind: "pending", title: `${c.label}: submitted`, body: "Waiting for confirmation…", href: txUrl(hash) });
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: bscTestnet.id });
        const lines = decodeReceipt(receipt);
        if (receipt.status === "success") {
          toast.update(id, { kind: "success", title: `${c.label}: confirmed`, body: `Block ${receipt.blockNumber}`, lines, href: txUrl(hash) });
        } else {
          toast.update(id, { kind: "error", title: `${c.label}: reverted`, href: txUrl(hash) });
        }
        return receipt;
      } catch (e) {
        const msg = describeError(e);
        if (id !== null) toast.update(id, { kind: "error", title: `${c.label}: failed`, body: msg });
        else toast.push({ kind: "error", title: `${c.label}: failed`, body: msg });
        return null;
      } finally {
        setPending(null);
      }
    },
    [config, ensure, toast],
  );

  /** Raw tx (pull mode: calldata ‖ Atlas payload). Simulated with eth_call first. */
  const sendRaw = useCallback(
    async (to: Address, data: Hex, label: string, value?: bigint): Promise<TransactionReceipt | null> => {
      let id: number | null = null;
      setPending(label);
      try {
        const account = await ensure();
        await call(config, { account, to, data, value, chainId: bscTestnet.id });
        const hash = await sendTransaction(config, { to, data, value, chainId: bscTestnet.id });
        id = toast.push({ kind: "pending", title: `${label}: submitted`, href: txUrl(hash) });
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: bscTestnet.id });
        toast.update(id, { kind: receipt.status === "success" ? "success" : "error", title: `${label}: ${receipt.status === "success" ? "confirmed" : "reverted"}`, lines: decodeReceipt(receipt), href: txUrl(hash) });
        return receipt;
      } catch (e) {
        const msg = describeError(e);
        if (id !== null) toast.update(id, { kind: "error", title: `${label}: failed`, body: msg });
        else toast.push({ kind: "error", title: `${label}: failed`, body: msg });
        return null;
      } finally {
        setPending(null);
      }
    },
    [config, ensure, toast],
  );

  return { send, sendRaw, pending, account: address, isConnected };
}
