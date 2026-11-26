"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { decodeEventLog, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { useAccount, useConfig, useReadContracts } from "wagmi";
import { signMessage } from "wagmi/actions";
import { OpenFourCoreAbi, OpenFourToolsAbi } from "@/abi";
import { useToast } from "@/components/Toaster";
import { OF } from "@/hooks/useOpenFour";
import { deployments97 } from "@/config/deployments";
import { useTx } from "@/hooks/useTx";
import { brandHit, encodeCreateArgs, requestMessage, TOKEN_BASE_FALLBACK, type ModuleSchema, type ParamDescriptor, type PresetSchemas } from "@/lib/openfour";

const GROUPS: { key: keyof Omit<PresetSchemas, "base">; title: string }[] = [
  { key: "token", title: "Token module" },
  { key: "vault", title: "Vault module" },
  { key: "curve", title: "Curve (fair launch)" },
  { key: "trade", title: "Trade limits and fees" },
  { key: "migrate", title: "Graduation into a SplitStock pool" },
  { key: "customData", title: "Custom data" },
];

function mapParam(p: Partial<ParamDescriptor>): ParamDescriptor {
  return {
    name: p.name ?? "",
    abiType: p.abiType ?? "uint256",
    decimals: Number(p.decimals ?? 0),
    optional: Boolean(p.optional),
    title: p.title ?? "",
    defaultValue: p.defaultValue ?? "",
    hint: p.hint ?? "",
    minValue: p.minValue ?? "",
    maxValue: p.maxValue ?? "",
  };
}
function mapSchema(raw: unknown): ModuleSchema {
  const r = (raw ?? {}) as { kind?: string; version?: number; params?: Partial<ParamDescriptor>[] };
  return { kind: r.kind ?? "", version: Number(r.version ?? 1), params: (r.params ?? []).map(mapParam) };
}

/** SchemaDrivenForm: one input per ParamDescriptor, in ABI order, from Tools.getPresetEncodeSchemas(presetId). */
function Field({ p, value, onChange }: { p: ParamDescriptor; value: string; onChange: (v: string) => void }) {
  const label = p.title || p.name;
  const unit = p.decimals > 0 ? ` (${p.decimals} dec units, enter a decimal)` : "";
  if (p.abiType === "bool") {
    return (
      <label className="of-label" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={value === "true" || value === "1"} onChange={(e) => onChange(e.target.checked ? "true" : "false")} />
        {label}
        {p.hint && <span style={{ color: "var(--of-placeholder)" }}> · {p.hint}</span>}
      </label>
    );
  }
  return (
    <label className="of-label">
      <span>
        {label}
        {!p.optional && <span style={{ color: "var(--of-danger)" }}> *</span>}
        <span style={{ color: "var(--of-placeholder)" }}>
          {" "}
          {p.abiType}
          {unit}
        </span>
      </span>
      <input
        className="of-input"
        value={value}
        placeholder={p.defaultValue || (p.abiType === "address" ? "0x…" : p.abiType.endsWith("[]") ? "comma-separated" : "")}
        onChange={(e) => onChange(e.target.value)}
      />
      {(p.hint || p.minValue || p.maxValue) && (
        <span style={{ fontSize: 12, color: "var(--of-placeholder)" }}>
          {p.hint}
          {p.minValue || p.maxValue ? ` [${p.minValue || "…"}, ${p.maxValue || "…"}]` : ""}
        </span>
      )}
    </label>
  );
}

export default function NewMemePage() {
  const router = useRouter();
  const config = useConfig();
  const toast = useToast();
  const { address } = useAccount();
  const { send, pending } = useTx();
  const [form, setForm] = useState<Record<string, string>>({});
  const [createFee, setCreateFee] = useState("0");
  const [busy, setBusy] = useState<string | null>(null);

  const reads = useReadContracts({
    allowFailure: true,
    query: { enabled: !!OF.tools && OF.presetId !== undefined },
    contracts: [
      { address: OF.tools!, abi: OpenFourToolsAbi, functionName: "getPresetEncodeSchemas", args: [OF.presetId ?? 0n], chainId: bscTestnet.id },
      { address: OF.tools!, abi: OpenFourToolsAbi, functionName: "getTokenBaseSchema", chainId: bscTestnet.id },
    ],
  });

  const schemas: PresetSchemas | null = useMemo(() => {
    const r0 = reads.data?.[0];
    if (r0?.status !== "success") return null;
    const [token, vault, curve, trade, migrate, customData] = r0.result as unknown as unknown[];
    const r1 = reads.data?.[1];
    const base = r1?.status === "success" ? (r1.result as unknown as Partial<ParamDescriptor>[]).map(mapParam) : TOKEN_BASE_FALLBACK;
    return { base, token: mapSchema(token), vault: mapSchema(vault), curve: mapSchema(curve), trade: mapSchema(trade), migrate: mapSchema(migrate), customData: mapSchema(customData) };
  }, [reads.data]);

  useEffect(() => {
    if (!schemas) return;
    // Address params the SplitPoolPresetValidator pins: prefill them from deployments/97.json.
    const pinned: Record<string, string | undefined> = {
      stockAsset: OF.quoteAsset,
      poolFactory: deployments97.core.poolFactory,
      feed: deployments97.oracles.TSLA && typeof deployments97.oracles.TSLA === "object" ? deployments97.oracles.TSLA.mirror : undefined,
      poolRouter: deployments97.dex.router,
      backstopTreasury: OF.treasury,
      feeRecipient: OF.treasury,
      stockSymbol: "TSLA",
    };
    const init: Record<string, string> = {};
    for (const p of [...schemas.base, ...GROUPS.flatMap((g) => schemas[g.key].params)]) {
      if (p.defaultValue) init[p.name] = p.defaultValue;
      const pin = pinned[p.name];
      if (pin && !init[p.name]) init[p.name] = pin;
    }
    setForm((f) => ({ ...init, ...f }));
  }, [schemas]);

  const blocked = brandHit(form.name ?? "", form.symbol ?? "");
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!schemas || !OF.core || OF.presetId === undefined || !OF.quoteAsset || !address) return;
    try {
      setBusy("Encoding");
      const requestId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
      const createArgs = encodeCreateArgs({
        requestId,
        presetId: OF.presetId,
        validTimestamp: BigInt(Math.floor(Date.now() / 1000) + 3000),
        createFee: BigInt(createFee || "0"),
        presaleQuote: 0n,
        quoteAsset: OF.quoteAsset,
        partner: OF.treasury,
        form,
        schemas,
      });
      setBusy("Sign the request in your wallet");
      const requestSignature = await signMessage(config, { message: requestMessage(bscTestnet.id, address, requestId, createArgs) });
      setBusy("Server checks and signs");
      const res = await fetch("/api/openfour/sign-create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caller: address, createArgs, requestSignature }) });
      const body = (await res.json()) as { signature?: Hex; createFee?: string; error?: string; term?: string; expected?: string };
      if (!res.ok || !body.signature) throw new Error(`${body.error ?? res.status}${body.term ? `: ${body.term}` : ""}${body.expected ? ` (expected ${body.expected})` : ""}`);
      setBusy(null);
      const receipt = await send({ address: OF.core, abi: OpenFourCoreAbi, functionName: "createToken", args: [createArgs, body.signature], value: BigInt(body.createFee ?? "0"), label: "Create meme" });
      if (!receipt || receipt.status !== "success") return;
      await fetch("/api/openfour/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash: receipt.transactionHash }) });
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: OpenFourCoreAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "TokenCreated") {
            router.push(`/memes/${ev.args.token}`);
            return;
          }
        } catch {
          /* other log */
        }
      }
      router.push("/memes");
    } catch (e) {
      toast.push({ kind: "error", title: "Create failed", body: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h1 className="of-title">Create a meme (SplitStock Pool Launch)</h1>
      <p className="of-lede">
        Fields come from <code>Tools.getPresetEncodeSchemas({OF.presetId?.toString() ?? "presetId"})</code>. The quote asset is fixed to tTSLA. Names that use a listed company&apos;s brand (NVIDIA, Tesla, …) are refused.
      </p>
      {!OF.tools || OF.presetId === undefined ? (
        <div className="of-panel">The OpenFour fork Tools contract or presetId is not in deployments/97.json yet.</div>
      ) : !schemas ? (
        <div className="of-panel">{reads.isLoading ? "Reading preset schemas…" : "Could not read the preset schemas from Tools."}</div>
      ) : (
        <div className="of-grid">
          <section className="of-panel of-panel-brand">
            <div style={{ color: "var(--of-text)", fontWeight: 700, marginBottom: 10 }}>Token</div>
            <div className="of-grid of-grid-2">
              {schemas.base.map((p) => (
                <Field key={p.name} p={p} value={form[p.name] ?? ""} onChange={set(p.name)} />
              ))}
            </div>
            {blocked && <p style={{ color: "var(--of-danger)", fontSize: 13, marginTop: 8 }}>“{blocked}” is a protected brand. Pick another name.</p>}
          </section>
          {GROUPS.filter((g) => schemas[g.key].params.length > 0).map((g) => (
            <section key={g.key} className="of-panel">
              <div style={{ color: "var(--of-text)", fontWeight: 700, marginBottom: 10 }}>
                {g.title} <span style={{ color: "var(--of-placeholder)", fontWeight: 400, fontSize: 12 }}>{schemas[g.key].kind} v{schemas[g.key].version}</span>
              </div>
              <div className="of-grid of-grid-2">
                {schemas[g.key].params.map((p) => (
                  <Field key={`${g.key}.${p.name}`} p={p} value={form[p.name] ?? ""} onChange={set(p.name)} />
                ))}
              </div>
            </section>
          ))}
          <section className="of-panel">
            <label className="of-label">
              Create fee (wei of native tBNB, normally 0 on the fork)
              <input className="of-input" value={createFee} onChange={(e) => setCreateFee(e.target.value.replace(/[^0-9]/g, ""))} />
            </label>
            <button className="of-btn of-btn-primary" style={{ marginTop: 14, width: "100%" }} disabled={!address || !!blocked || !!busy || !!pending} onClick={submit}>
              {!address ? "Connect a wallet" : busy ?? pending ?? "Sign and create"}
            </button>
            <p style={{ fontSize: 12, marginTop: 8 }}>
              Flow: your wallet signs an EIP-191 request → /api/openfour/sign-create checks preset, quote asset, validity window, request id, brand list and your daily limit → the UI signer signs the create digest for your address only → you send Core.createToken().
            </p>
          </section>
        </div>
      )}
    </>
  );
}
