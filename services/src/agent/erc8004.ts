import { decodeEventLog, type Address, type Hex } from "viem";
import { erc8004IdentityAbi, erc8004ReputationAbi } from "../abi/index.js";
import { env } from "../config/env.js";
import { agentIdFrom, loadDeployments } from "../config/deployments.js";
import { hashJSON } from "../lib/canonical.js";
import { signer, type ChainKind } from "../lib/chains.js";
import { sendTx } from "../lib/tx.js";

/**
 * ERC-8004 identity for the Risk Steward (testnet 97 and mainnet 56). Registries (read live 26 Nov):
 *   97: Identity 0x8004A818BFB912233c491871b3d84c89A494BD9e, Reputation 0x8004B663056A597Dffe9eCcC1965A193B7388713
 *   56: Identity 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432, Reputation 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 * Addresses are read from deployments/<chain>.json erc8004.*. The agentURI JSON is served by the API at
 * GET /agent/registration.json?chain=<id>. Feedback comes from a separate evaluator key (disclosed as self-assessment).
 */
export function chainIdOf(kind: ChainKind): number {
  return kind === "testnet" ? env().CHAIN_ID : env().MAINNET_CHAIN_ID;
}

export function agentUri(chainId: number): string {
  return `${env().PUBLIC_BASE_URL.replace(/\/$/, "")}/agent/registration.json?chain=${chainId}`;
}

export function registrationJson(chainId: number) {
  const d = loadDeployments(chainId);
  const base = env().PUBLIC_BASE_URL.replace(/\/$/, "");
  const identity = d?.erc8004?.identity;
  const agentId = agentIdFrom(d);
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "SplitStock Risk Steward",
    description:
      "Bounded AI risk agent for SplitStock tokenized-stock pools. Reads on-chain state, keeper metrics, Atlas prices and CoinMarketCap MCP data, " +
      "then proposes tighten-first risk parameters to RiskOracle. It cannot move funds, post prices or pause exits; loosening waits 30 minutes and can be vetoed.",
    image: `${base}/agent/avatar.png`,
    services: [
      { name: "web", endpoint: `${base}/agent/proposals` },
      { name: "raw-io", endpoint: `${base}/agent/raw/{hash}` },
    ],
    x402Support: false,
    active: true,
    registrations: agentId !== undefined && identity ? [{ agentId: Number(agentId), agentRegistry: `eip155:${chainId}:${identity}` }] : [],
    supportedTrust: ["reputation"],
  };
}

/** register(agentURI) from the chain's agent key (97: AGENT_PRIVATE_KEY, 56: AGENT56_PRIVATE_KEY). */
export async function registerAgent(kind: ChainKind, dryRun = false) {
  const chainId = chainIdOf(kind);
  const identity = loadDeployments(chainId)?.erc8004?.identity;
  if (!identity) throw new Error(`deployments/${chainId}.json has no erc8004.identity`);
  const s = signer(kind === "testnet" ? "agent" : "agent56");
  if (!s) throw new Error(`no agent key for chain ${chainId}`);
  const uri = agentUri(chainId);
  const r = await sendTx(s, "erc8004", { address: identity, abi: erc8004IdentityAbi, functionName: "register", args: [uri] }, { dryRun });
  let agentId: bigint | undefined = typeof r.result === "bigint" ? r.result : undefined;
  for (const l of r.receipt?.logs ?? []) {
    if (l.address.toLowerCase() !== identity.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: erc8004IdentityAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Transfer") agentId = ev.args.tokenId;
    } catch {
      /* other events */
    }
  }
  return { chainId, identity, agentURI: uri, owner: s.account.address, ok: r.ok, tx: r.hash, agentId: agentId?.toString(), reason: r.ok ? undefined : (r.revert ?? r.error), next: "write erc8004.agentId into deployments/<chain>.json" };
}

/**
 * setAgentWallet(agentId, newWallet, deadline, signature) with an EIP-712 signature from the new wallet.
 * [UNVERIFIED] typed-data struct name/fields: AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline).
 * The domain is read from the registry's eip712Domain().
 */
export async function setAgentWallet(kind: ChainKind, agentId: bigint, ownerRole: "agent" | "agent56", walletRole: "agent" | "agent56", dryRun = false) {
  const chainId = chainIdOf(kind);
  const identity = loadDeployments(chainId)?.erc8004?.identity as Address | undefined;
  if (!identity) throw new Error("no erc8004.identity");
  const owner = signer(ownerRole);
  const wallet = signer(walletRole);
  if (!owner || !wallet) throw new Error("owner or wallet key missing");
  const dom = await owner.public.readContract({ address: identity, abi: erc8004IdentityAbi, functionName: "eip712Domain" });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const signature: Hex = await wallet.wallet.signTypedData({
    account: wallet.account,
    domain: { name: dom[1], version: dom[2], chainId: Number(dom[3]), verifyingContract: dom[4] },
    types: { AgentWalletSet: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "owner", type: "address" }, { name: "deadline", type: "uint256" }] },
    primaryType: "AgentWalletSet",
    message: { agentId, newWallet: wallet.account.address, owner: owner.account.address, deadline },
  });
  const r = await sendTx(owner, "erc8004", { address: identity, abi: erc8004IdentityAbi, functionName: "setAgentWallet", args: [agentId, wallet.account.address, deadline, signature] }, { dryRun });
  return { ok: r.ok, tx: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) };
}

/** Evaluator feedback on the testnet registry (self-assessment, separate key). [UNVERIFIED] giveFeedback signature. */
export async function giveFeedback(agentId: bigint, score: number, tag: string, dryRun = false) {
  const d = loadDeployments(env().CHAIN_ID);
  const rep = d?.erc8004?.reputation;
  if (!rep) throw new Error("no erc8004.reputation");
  const s = signer("evaluator");
  if (!s) throw new Error("EVALUATOR_PRIVATE_KEY not set");
  const base = env().PUBLIC_BASE_URL.replace(/\/$/, "");
  const body = { agentId: agentId.toString(), score, tag, note: "self-assessment by the SplitStock team evaluator key", at: new Date().toISOString() };
  const r = await sendTx(
    s,
    "erc8004",
    { address: rep, abi: erc8004ReputationAbi, functionName: "giveFeedback", args: [agentId, BigInt(score), 0, tag, "self-assessment", `${base}/agent/proposals`, `${base}/agent/registration.json`, hashJSON(body)] },
    { dryRun },
  );
  return { ok: r.ok, tx: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) };
}
