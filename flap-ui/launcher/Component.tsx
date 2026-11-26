import { useRef, useState, type CSSProperties, type ReactNode } from "react";

// SplitStock "Backstop-first crowdfund" Launcher UI for the Flap host (launcher-config-preview/v1).
// LauncherConfig = create view (encodes SplitLauncherFactory config). Launcher = detail view (reads + zero-arg actions).
// Addresses below are rewritten from deployments/97.json by flap-ui/scripts/sync-addresses.mjs. Do not edit by hand.

type Messages = Record<string, string>;
type Identity = Readonly<{ chainId: number; factoryAddress: string }>;
type Wallet = Readonly<{
  account: string | null;
  chainId: number | null;
  pendingHash?: string | null;
  connect(): void;
  switchChain(): Promise<void>;
}>;
type Action = "contribute" | "contributeBoosted" | "claim" | "refund" | "openPool";
type Submission = { status: "success" | "pending" | "reverted" | "unverified"; hash: string; launcherAddress?: string };
type AbiParameter = { name: string; type: string; components?: readonly AbiParameter[] };
type Host = Readonly<{
  wallet?: Wallet;
  quote?(): Promise<string | null>;
  encode?(parameters: readonly AbiParameter[], values: readonly unknown[]): string;
  findSalt?(): Promise<string>;
  submit?(input: { kind: "create"; configuration: string; valueWei: string }
    | { kind: "action"; action: Action; valueWei?: string }): Promise<Submission>;
  checkReceipt?(hash: string): Promise<Submission>;
  refresh?(): void;
  redirect?(path: string): boolean;
  openLauncher?(address: string): void;
}>;

type ConfigProps = {
  context: Readonly<{ identity: Identity; locale: string; previewOnly?: boolean }>;
  messages: Messages;
  host?: Host;
};
type Snapshot = Readonly<{
  raised?: string | null;
  targetRaise?: string | null;
  remaining?: string | null;
  saleDeadline?: string | null;
  launched?: boolean | null;
  token?: string | null;
  predictedToken?: string | null;
  failed?: boolean | null;
  seedBalance?: string | null;
  boostToken?: string | null;
  pool?: string | null;
  backstopVault?: string | null;
  backstopBufferUsd?: string | null;
  contributions?: string | null;
  claimable?: string | null;
  boosted?: boolean | null;
}>;
type DetailProps = {
  context: Readonly<{
    identity: Identity;
    locale: string;
    previewOnly?: boolean;
    launcherAddress: string | null;
    snapshot: Snapshot | null;
  }>;
  messages: Messages;
  host?: Host;
};

// ---- deployment constants (synced) ----
const splitFactory = "0x01013dce27c3f00cac8bf254e20d02fd3500ffd2"; // @sync flap.launcherFactory
const backstopVaultFactory = "0xa441ecbfd7a28c3b949c0672cbd637355e97f2c4"; // @sync flap.vaultFactory
const supportedChainId = 97;

// ---- fixed launch shape (mirrors SplitLauncher constants) ----
const totalSupplyText = "1,000,000";
const lpSupplyText = "500,000";
const crowdSupplyText = "500,000";
const boostEscrowText = "100";
const boostWeightText = "1.2x";

// ---- palette ----
const ink = "#13202f";
const navy = "#0f2a44";
const paper = "#f5f7fb";
const slate = "#51627a";
const rule = "#c9d3e1";
const amber = "#f3b33d";
const panel = "#e8eef7";

const shell: CSSProperties = {
  color: ink, background: paper, border: "1px solid #9fb0c8", borderRadius: 18, overflow: "hidden",
  fontFamily: '"Inter", "PingFang SC", "Apple SD Gothic Neo", system-ui, sans-serif',
  lineHeight: 1.5, colorScheme: "light", accentColor: navy,
};
const inset = "clamp(16px, 5vw, 32px)";
const heading: CSSProperties = {
  color: "#f2f6fc", padding: inset, background: navy, borderBlockStart: `5px solid ${amber}`,
  display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap",
};
const body: CSSProperties = { padding: inset, display: "grid", gap: 22 };
const fields: CSSProperties = { display: "grid", gap: 14, minWidth: 0 };
const columns: CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 14,
};
const input: CSSProperties = {
  appearance: "none", boxSizing: "border-box", minWidth: 0, width: "100%", minHeight: 44,
  border: "1px solid #9fb0c8", borderRadius: 7, padding: "9px 11px", color: ink,
  background: "#ffffff", font: "inherit", fontSize: 16, outlineOffset: 3,
};
const valueText: CSSProperties = {
  fontFamily: '"IBM Plex Mono", ui-monospace, monospace', fontVariantNumeric: "tabular-nums",
  overflowWrap: "anywhere", margin: "3px 0 0",
};
const muted: CSSProperties = { margin: 0, color: slate, fontSize: 13 };
const notice: CSSProperties = { margin: 0, color: "#8a1f1a", fontSize: 13 };
const card: CSSProperties = {
  border: `1px solid ${rule}`, borderRadius: 12, padding: "clamp(14px, 3vw, 22px)", background: panel, display: "grid", gap: 14,
};

const addressPattern = /^0x(?!0{40}$)[a-f0-9]{40}$/i;
const hashPattern = /^0x[a-f0-9]{64}$/i;
const unsigned = /^(0|[1-9][0-9]{0,77})$/;
const baseUnit = 10n ** 18n;
const usdUnit = 10n ** 18n; // backstopBufferUsd() is USD with 18 decimals
const minTargetWei = baseUnit / 2n; // 0.5 tBNB; the factory enforces the live Portal floor x 1.1
const maxTargetWei = 1000n * baseUnit;
const minSaleHours = 1;
const maxSaleHours = 30 * 24;
const maxNameBytes = 32;
const maxSymbolBytes = 10;
const maxMetaBytes = 512;

// abi.encode(SplitLaunchConfig) — must match SplitLauncherFactory strict decode and launcherDataSchema() order.
const factoryParameters: readonly AbiParameter[] = [
  { name: "config", type: "tuple", components: [
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "meta", type: "string" },
    { name: "salt", type: "bytes32" },
    { name: "targetRaise", type: "uint256" },
    { name: "backstopSeed", type: "uint256" },
    { name: "saleDuration", type: "uint256" },
    { name: "vaultFactory", type: "address" },
  ] },
];

function buttonStyle(disabled = false, secondary = false): CSSProperties {
  return {
    minHeight: 44, borderRadius: 8, padding: "8px 16px",
    border: secondary ? `1px solid ${rule}` : 0,
    background: secondary ? "transparent" : navy, color: secondary ? ink : "#f2f6fc",
    font: "inherit", fontSize: 14, fontWeight: 700,
    opacity: disabled ? 0.5 : 1, cursor: disabled ? "default" : "pointer",
  };
}

function sameAddress(a: string | null | undefined, b: string) {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

function supportsIdentity(identity: Identity) {
  return identity.chainId === supportedChainId && sameAddress(identity.factoryAddress, splitFactory);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && hashPattern.test(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && addressPattern.test(value);
}

function byteLength(text: string) {
  return unescape(encodeURIComponent(text)).length;
}

function asUnits(value: string | null | undefined) {
  return typeof value === "string" && unsigned.test(value) ? BigInt(value) : null;
}

function decimalAmount(value: bigint, unit = baseUnit, digits = 18, maxFraction = 6) {
  const whole = value / unit;
  const fraction = (value % unit).toString().padStart(digits, "0").slice(0, maxFraction).replace(/0+$/, "");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return grouped + (fraction ? "." + fraction : "");
}

function exactAmount(value: bigint) {
  const fraction = (value % baseUnit).toString().padStart(18, "0").replace(/0+$/, "");
  return `${value / baseUnit}${fraction ? "." + fraction : ""}`;
}

function nativeAmount(value: bigint | null, fallback: string) {
  return value === null ? fallback : `${decimalAmount(value)} tBNB`;
}

function tokenAmount(value: bigint | null, symbol: string, fallback: string) {
  return value === null ? fallback : `${decimalAmount(value, baseUnit, 18, 4)} ${symbol}`;
}

function usdAmount(value: bigint | null, fallback: string) {
  return value === null ? fallback : `$${decimalAmount(value, usdUnit, 18, 2)}`;
}

function parseNative(text: string) {
  const match = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,18}))?$/.exec(text.trim());
  return match ? BigInt(match[1]) * baseUnit + BigInt((match[2] ?? "").padEnd(18, "0")) : null;
}

function utcTime(seconds: bigint | null, fallback: string) {
  if (seconds === null || seconds <= 0n || seconds > 253402300799n) return fallback;
  // Civil date from epoch seconds with integer math only (no Date constructor; Workbench policy).
  const secs = Number(seconds);
  const days = Math.floor(secs / 86400);
  const rem = secs - days * 86400;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const pad = (n: number) => (n < 10 ? "0" : "") + n;
  return `${year}-${pad(month)}-${pad(day)} ${pad(Math.floor(rem / 3600))}:${pad(Math.floor((rem % 3600) / 60))} UTC`;
}

function shortAddress(value: string) {
  return value.slice(0, 8) + "…" + value.slice(-6);
}

function reportedStatus(receipt: Submission | null, m: Messages) {
  if (!receipt) return null;
  const statuses = { success: m.success, pending: m.pending, reverted: m.reverted, unverified: m.unverified };
  return (
    <div role="status" style={{ ...muted, display: "grid", gap: 4 }}>
      <span>{statuses[receipt.status]}</span>
      {isHash(receipt.hash) && <span style={valueText}>{receipt.hash}</span>}
    </div>
  );
}

function recoveryNeeded(receipt: Submission | null) {
  return receipt?.status === "pending" || receipt?.status === "unverified";
}

function visibleReceipt(receipt: Submission | null, pendingHash: string | null | undefined): Submission | null {
  if (isHash(pendingHash) && receipt?.hash !== pendingHash) return { status: "pending", hash: pendingHash };
  return receipt;
}

function localizedError(cause: unknown, m: Messages, fallback: string) {
  if (!(cause instanceof Error)) return fallback;
  const errors: Record<string, string> = {
    walletUnavailable: m.walletUnavailable, connectWallet: m.connectWallet, wrongChain: m.switchChain,
    walletRejected: m.walletRejected, walletBusy: m.walletBusy, simulationFailed: m.simulationFailed,
    creationFeeChanged: m.feeChanged, factoryUnavailable: m.factoryUnavailable,
    invalidTransaction: m.submitError, saltUnavailable: m.saltUnavailable, receiptUnavailable: m.receiptError,
  };
  return Object.hasOwn(errors, cause.message) ? errors[cause.message] : fallback;
}

function Header({ title, intro, network }: { title: string; intro: string; network: string }) {
  return (
    <header style={heading}>
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: "clamp(24px, 5vw, 38px)", lineHeight: 1.12, letterSpacing: "-0.03em" }}>{title}</h2>
        <p style={{ margin: "9px 0 0", fontSize: 14, color: "#c7d4e6" }}>{intro}</p>
      </div>
      <span style={{ padding: "4px 10px", border: `1px solid ${amber}`, borderRadius: 20, fontSize: 12, whiteSpace: "nowrap" }}>
        {network}
      </span>
    </header>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 5, minWidth: 0, alignContent: "start" }}>
      <span style={{ fontWeight: 700, fontSize: 14 }}>{label}</span>
      {children}
      {error ? <span style={notice}>{error}</span> : hint ? <span style={muted}>{hint}</span> : null}
    </label>
  );
}

function Divider({ children }: { children: ReactNode }) {
  return <h3 style={{ margin: 0, paddingBlockStart: 13, borderBlockStart: `1px solid ${rule}`, fontSize: 16 }}>{children}</h3>;
}

function Datum({ label, children }: { label: string; children: ReactNode }) {
  return <div style={{ minWidth: 0 }}><dt style={muted}>{label}</dt><dd style={{ ...valueText, marginInlineStart: 0 }}>{children}</dd></div>;
}

// ------------------------------------------------------------------------------------------
// LauncherConfig: create view
// ------------------------------------------------------------------------------------------

const initialForm = { name: "", symbol: "", meta: "", targetRaise: "4.7", backstopSeed: "0.2", saleHours: "72" };
type Form = typeof initialForm;
type FieldErrors = Partial<Record<keyof Form, string>>;
type ReviewedConfig = {
  name: string; symbol: string; meta: string;
  targetRaise: bigint; backstopSeed: bigint; saleDuration: bigint;
};

function validate(form: Form, m: Messages): { values: ReviewedConfig | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const name = form.name.trim(), symbol = form.symbol.trim(), meta = form.meta.trim();
  if (!name) errors.name = m.required;
  else if (byteLength(name) > maxNameBytes) errors.name = m.nameTooLong;
  if (!symbol) errors.symbol = m.required;
  else if (byteLength(symbol) > maxSymbolBytes || !/^[A-Za-z0-9]+$/.test(symbol)) errors.symbol = m.symbolInvalid;
  if (byteLength(meta) > maxMetaBytes) errors.meta = m.metaTooLong;
  const targetRaise = parseNative(form.targetRaise);
  if (targetRaise === null || targetRaise < minTargetWei || targetRaise > maxTargetWei) errors.targetRaise = m.targetInvalid;
  const backstopSeed = parseNative(form.backstopSeed);
  if (backstopSeed === null || backstopSeed === 0n) errors.backstopSeed = m.seedInvalid;
  else if (targetRaise !== null && backstopSeed * 2n > targetRaise) errors.backstopSeed = m.seedTooLarge;
  const hours = /^[1-9][0-9]{0,3}$/.test(form.saleHours) ? Number(form.saleHours) : null;
  if (hours === null || hours < minSaleHours || hours > maxSaleHours) errors.saleHours = m.durationInvalid;
  const ok = Object.keys(errors).length === 0 && targetRaise !== null && backstopSeed !== null && hours !== null;
  return {
    errors,
    values: ok ? { name, symbol, meta, targetRaise, backstopSeed, saleDuration: BigInt(hours * 3600) } : null,
  };
}

type CreationReview = { values: ReviewedConfig; fee: string | null };

export function LauncherConfig({ context, messages: m, host }: ConfigProps) {
  const [form, setForm] = useState<Form>(initialForm);
  const [touched, setTouched] = useState(false);
  const [review, setReview] = useState<CreationReview | null>(null);
  const [prepared, setPrepared] = useState<{ configuration: string; account: string; valueWei: string } | null>(null);
  const [result, setResult] = useState<{ account: string; receipt: Submission } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const { values: draft, errors } = validate(form, m);
  const shown: FieldErrors = touched ? errors : {};
  const account = host?.wallet?.account ?? null;
  const wrongChain = host?.wallet?.chainId !== context.identity.chainId;
  const factory = context.identity.factoryAddress;
  const factoryMatches = supportsIdentity(context.identity);
  const canTransact = factoryMatches && !!host?.wallet && !!host?.quote && !!host?.findSalt && !!host?.encode && !!host?.submit;
  const receipt = visibleReceipt(result?.account === account?.toLowerCase() ? result?.receipt ?? null : null, host?.wallet?.pendingHash);
  const waiting = recoveryNeeded(receipt);
  const finished = receipt?.status === "success";
  const created = finished && isAddress(receipt?.launcherAddress) ? receipt?.launcherAddress ?? null : null;
  const sameWallet = !!account && prepared?.account === account.toLowerCase();
  const poolQuote = draft ? draft.targetRaise - draft.backstopSeed : null;

  const update = (key: keyof Form, value: string) => {
    setForm(current => ({ ...current, [key]: value }));
    setReview(null);
    setPrepared(null);
    setError(null);
  };

  async function showReview() {
    setTouched(true);
    const values = validate(form, m).values;
    if (!values || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const fee = canTransact ? await host?.quote?.() : null;
      if (canTransact && (fee == null || !unsigned.test(fee))) setError(m.feeUnavailable);
      setReview({ values, fee: fee != null && unsigned.test(fee) ? fee : null });
    } catch {
      setError(m.feeUnavailable);
      setReview({ values, fee: null });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function prepareCreation() {
    if (!canTransact || !review || !draft || lock.current || finished || waiting) return;
    if (!account) { host?.wallet?.connect(); return; }
    lock.current = true;
    setBusy(true);
    setError(null);
    setPrepared(null);
    try {
      if (wrongChain) { await host?.wallet?.switchChain(); return; }
      const fee = await host?.quote?.();
      if (fee == null || !unsigned.test(fee)) { setError(m.feeUnavailable); return; }
      if (fee !== review.fee) {
        setReview({ ...review, fee });
        setError(m.feeChanged);
        return;
      }
      const salt = await host?.findSalt?.();
      if (!isHash(salt)) { setError(m.saltUnavailable); return; }
      const { values } = review;
      const configuration = host?.encode?.(factoryParameters, [{
        name: values.name, symbol: values.symbol, meta: values.meta, salt,
        targetRaise: values.targetRaise, backstopSeed: values.backstopSeed, saleDuration: values.saleDuration,
        vaultFactory: backstopVaultFactory,
      }]);
      if (!configuration) { setError(m.prepareError); return; }
      setPrepared({ configuration, account: account.toLowerCase(), valueWei: fee });
    } catch (cause) {
      setError(localizedError(cause, m, m.prepareError));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function confirmCreation() {
    if (!canTransact || !prepared || !account || !sameWallet || wrongChain || lock.current || finished || waiting) return;
    if (!validate(form, m).values) { setPrepared(null); setError(m.draftIncomplete); return; }
    lock.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const submitted = await host?.submit?.({ kind: "create", configuration: prepared.configuration, valueWei: prepared.valueWei });
      if (submitted) setResult({ account: account.toLowerCase(), receipt: submitted });
      setPrepared(null);
    } catch (cause) {
      setPrepared(null);
      setError(localizedError(cause, m, m.submitError));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function checkCreation() {
    if (!account || !receipt || !isHash(receipt.hash) || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const checked = await host?.checkReceipt?.(receipt.hash);
      if (checked) setResult({ account: account.toLowerCase(), receipt: checked });
    } catch (cause) {
      setError(localizedError(cause, m, m.receiptError));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <section style={shell} aria-label={m.createTitle}>
      <Header title={m.createTitle} intro={m.createIntro} network={m.network} />
      <div style={{ ...body, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", alignItems: "start" }}>
        <fieldset disabled={busy || waiting || finished} style={{ ...fields, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Divider>{m.tokenSection}</Divider>
          <div style={columns}>
            <Field label={m.name} hint={m.nameHint} error={shown.name}>
              <input name="name" value={form.name} maxLength={64} autoComplete="off" required style={input}
                aria-invalid={!!shown.name} onChange={event => update("name", event.target.value)} />
            </Field>
            <Field label={m.symbol} hint={m.symbolHint} error={shown.symbol}>
              <input name="symbol" value={form.symbol} maxLength={10} autoComplete="off" required style={input}
                aria-invalid={!!shown.symbol} onChange={event => update("symbol", event.target.value)} />
            </Field>
          </div>
          <Field label={m.meta} hint={m.metaHint} error={shown.meta}>
            <input name="meta" value={form.meta} maxLength={maxMetaBytes} autoComplete="off" style={input}
              aria-invalid={!!shown.meta} onChange={event => update("meta", event.target.value)} />
          </Field>

          <Divider>{m.raiseSection}</Divider>
          <div style={columns}>
            <Field label={m.targetRaise} hint={m.targetHint} error={shown.targetRaise}>
              <input name="targetRaise" value={form.targetRaise} inputMode="decimal" maxLength={26} required style={input}
                aria-invalid={!!shown.targetRaise} onChange={event => update("targetRaise", event.target.value)} />
            </Field>
            <Field label={m.backstopSeed} hint={m.seedHint} error={shown.backstopSeed}>
              <input name="backstopSeed" value={form.backstopSeed} inputMode="decimal" maxLength={26} required style={input}
                aria-invalid={!!shown.backstopSeed} onChange={event => update("backstopSeed", event.target.value)} />
            </Field>
          </div>
          <Field label={m.saleHours} hint={m.durationHint} error={shown.saleHours}>
            <input name="saleHours" value={form.saleHours} inputMode="numeric" maxLength={4} required style={input}
              aria-invalid={!!shown.saleHours} onChange={event => update("saleHours", event.target.value)} />
          </Field>

          <Divider>{m.fixedSection}</Divider>
          <dl style={{ ...columns, margin: 0 }}>
            <Datum label={m.totalSupply}>{totalSupplyText}</Datum>
            <Datum label={m.lpSupply}>{lpSupplyText}</Datum>
            <Datum label={m.crowdSupply}>{crowdSupplyText}</Datum>
            <Datum label={m.taxRate}>3% / 3%</Datum>
          </dl>
          <p style={muted}>{m.feeSplit}</p>
          <p style={muted}>{m.mechanism}</p>
        </fieldset>

        <aside style={card}>
          <h3 style={{ margin: 0, fontSize: 17 }}>{review ? m.reviewCreation : m.summary}</h3>
          <dl style={{ margin: 0, display: "grid", gap: 12 }}>
            <Datum label={m.token}>
              {(review?.values.name ?? form.name.trim()) || m.unknown}
              {(review?.values.symbol ?? form.symbol.trim()) ? " (" + (review?.values.symbol ?? form.symbol.trim()) + ")" : ""}
            </Datum>
            <Datum label={m.targetRaise}>{nativeAmount(review?.values.targetRaise ?? draft?.targetRaise ?? null, m.unknown)}</Datum>
            <Datum label={m.lpQuote}>{nativeAmount(poolQuote, m.unknown)}</Datum>
            <Datum label={m.backstopSeed}>{nativeAmount(review?.values.backstopSeed ?? draft?.backstopSeed ?? null, m.unknown)}</Datum>
            <Datum label={m.saleHours}>{draft ? String(Number(draft.saleDuration) / 3600) + " h" : m.unknown}</Datum>
            <Datum label={m.factory}><span title={factory}>{shortAddress(factory)}</span></Datum>
            {review && canTransact && <Datum label={m.creationFee}>{nativeAmount(asUnits(review.fee), m.unknown)}</Datum>}
            {review && sameWallet && <Datum label={m.walletAccount}>{account}</Datum>}
          </dl>
          <p role="status" style={{ margin: 0, paddingBlockStart: 12, borderBlockStart: `1px solid ${rule}`, fontSize: 13, fontWeight: 700 }}>
            {!factoryMatches ? m.factoryMismatch
              : review ? canTransact ? (sameWallet ? m.confirmReady : m.prepareHelp) : m.reviewOnly
              : draft ? m.draftReady : m.draftIncomplete}
          </p>
          {review && <p style={muted}>{m.floorNote}</p>}
          {error && <p role="alert" style={notice}>{error}</p>}
          {reportedStatus(receipt, m)}
          {created && (
            <>
              <dl style={{ margin: 0 }}><Datum label={m.launcher}>{created}</Datum></dl>
              {host?.openLauncher && <button type="button" style={buttonStyle()} onClick={() => host?.openLauncher?.(created)}>{m.openLauncher}</button>}
            </>
          )}
          {waiting && host?.checkReceipt && (
            <button type="button" disabled={busy} style={buttonStyle(busy)} onClick={() => void checkCreation()}>{m.checkReceipt}</button>
          )}
          {!waiting && !finished && (
            <div style={{ display: "grid", gap: 8 }}>
              {review && canTransact && (
                <button type="button" disabled={busy || !draft} style={buttonStyle(busy || !draft)}
                  onClick={sameWallet && !wrongChain ? () => void confirmCreation() : () => void prepareCreation()}>
                  {busy ? m.working : !account ? m.connectWallet : wrongChain ? m.switchChain
                    : sameWallet ? m.confirmCreation : m.prepareCreation}
                </button>
              )}
              <button type="button" disabled={busy} style={buttonStyle(busy, !!review)}
                onClick={review ? () => { setReview(null); setPrepared(null); setError(null); } : () => void showReview()}>
                {review ? m.editConfiguration : busy ? m.working : m.reviewCreation}
              </button>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------
// Launcher: detail view
// ------------------------------------------------------------------------------------------

type Review = { action: Action; account: string; valueWei?: string };

export function Launcher({ context, messages: m, host }: DetailProps) {
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [result, setResult] = useState<{ account: string; action?: Action; receipt: Submission } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [navigationFailed, setNavigationFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const { launcherAddress, snapshot, identity } = context;

  const raised = asUnits(snapshot?.raised);
  const target = asUnits(snapshot?.targetRaise);
  const remaining = asUnits(snapshot?.remaining) ?? (raised !== null && target !== null && target >= raised ? target - raised : null);
  const deadline = asUnits(snapshot?.saleDeadline);
  const launched = snapshot?.launched === true;
  const token = isAddress(snapshot?.token) ? snapshot?.token ?? null : null;
  const predicted = isAddress(snapshot?.predictedToken) ? snapshot?.predictedToken ?? null : null;
  const pool = isAddress(snapshot?.pool) ? snapshot?.pool ?? null : null;
  const vault = isAddress(snapshot?.backstopVault) ? snapshot?.backstopVault ?? null : null;
  const bufferUsd = asUnits(snapshot?.backstopBufferUsd);
  const contributed = asUnits(snapshot?.contributions);
  const claimable = asUnits(snapshot?.claimable);
  const boosted = snapshot?.boosted ?? null;
  const failed = snapshot?.failed === true;
  const seedBalance = asUnits(snapshot?.seedBalance);
  const boostAvailable = isAddress(snapshot?.boostToken) && !/^0x0{40}$/i.test(snapshot?.boostToken ?? "");

  const progressBps = raised !== null && target !== null && target > 0n ? raised * 10_000n / target : null;
  const progress = progressBps === null ? null : Number(progressBps > 10_000n ? 10_000n : progressBps) / 100;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const saleOpen = snapshot?.launched === false && !failed && deadline !== null && now < deadline && remaining !== null && remaining > 0n;
  const expired = snapshot?.launched === false && deadline !== null && now >= deadline;
  const refundable = snapshot?.launched === false && (failed || expired);
  const status = launched ? (pool ? m.poolOpen : m.launchedStatus) : failed ? m.failedStatus : expired ? m.refundsOpen
    : saleOpen ? m.saleOpen : snapshot?.launched === false ? m.notLaunched : m.unknown;

  const canTransact = supportsIdentity(identity) && !!host?.wallet && !!host?.submit;
  const account = host?.wallet?.account?.toLowerCase() ?? null;
  const wrongChain = host?.wallet?.chainId !== identity.chainId;
  const currentResult = result?.account === account ? result : null;
  const receipt = visibleReceipt(currentResult?.receipt ?? null, host?.wallet?.pendingHash);
  const waiting = recoveryNeeded(receipt);
  const inputWei = parseNative(amount);
  const amountValid = inputWei !== null && inputWei > 0n && remaining !== null && inputWei <= remaining;
  const fills = amountValid && inputWei === remaining;
  const options: Record<Action, { enabled: boolean; label: string }> = {
    contribute: { enabled: saleOpen && amountValid, label: m.contribute },
    contributeBoosted: { enabled: saleOpen && amountValid && boosted === false && boostAvailable, label: m.contributeBoosted },
    claim: { enabled: launched && claimable !== null && claimable > 0n, label: m.claim },
    refund: { enabled: refundable && contributed !== null && contributed > 0n, label: m.refund },
    openPool: { enabled: launched && snapshot?.pool === null && seedBalance !== null && seedBalance > 0n, label: m.openPool },
  };

  function actionReady(action: Action) {
    const oneShot = action !== "contribute";
    return options[action].enabled
      && !(oneShot && receipt?.status === "success" && currentResult?.action === action);
  }

  function editContribution(value: string) {
    setAmount(value);
    setReview(null);
    setError(null);
  }

  async function switchWalletChain() {
    if (!wrongChain || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try { await host?.wallet?.switchChain(); }
    catch (cause) { setError(localizedError(cause, m, m.walletUnavailable)); }
    finally { lock.current = false; setBusy(false); }
  }

  function startAction(action: Action) {
    if (!canTransact || !account || wrongChain || !actionReady(action) || waiting || lock.current) return;
    setError(null);
    const payable = action === "contribute" || action === "contributeBoosted";
    setReview({ action, account, ...(payable && inputWei !== null ? { valueWei: inputWei.toString() } : {}) });
  }

  function updateReceipt(submitted: Submission, current: { account: string; action?: Action }) {
    setResult({ ...current, receipt: submitted });
    if (submitted.status === "success") {
      if (current.action === "contribute" || current.action === "contributeBoosted") setAmount("");
      host?.refresh?.();
    }
  }

  async function confirmAction() {
    if (!review || !canTransact || !actionReady(review.action) || waiting || lock.current || wrongChain
      || account !== review.account) return;
    const payable = review.action === "contribute" || review.action === "contributeBoosted";
    if (payable && review.valueWei !== inputWei?.toString()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { action, valueWei } = review;
      const submitted = await host?.submit?.({ kind: "action", action, ...(valueWei === undefined ? {} : { valueWei }) });
      if (submitted) updateReceipt(submitted, { account: review.account, action });
    } catch (cause) {
      setError(localizedError(cause, m, m.submitError));
    } finally {
      setReview(null);
      lock.current = false;
      setBusy(false);
    }
  }

  async function checkAction() {
    if (!account || !receipt || !isHash(receipt.hash) || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const checked = await host?.checkReceipt?.(receipt.hash);
      if (checked) updateReceipt(checked, { account, action: currentResult?.action });
    } catch (cause) {
      setError(localizedError(cause, m, m.receiptError));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function openPath(path: string) {
    setNavigationFailed(host?.redirect?.(path) !== true);
  }

  const reviewStale = !!review && (!actionReady(review.action) || review.account !== account || wrongChain);
  const visibleActions = (["contribute", "contributeBoosted", "claim", "refund", "openPool"] as const).filter(action =>
    action === "contribute" || action === "contributeBoosted" ? saleOpen : actionReady(action));

  return (
    <section style={shell} aria-label={m.detailTitle}>
      <Header title={m.detailTitle} intro={m.detailIntro} network={m.network} />
      <div style={body}>
        {launcherAddress ? (
          <>
            <div style={card}>
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "start", flexWrap: "wrap" }}>
                <div>
                  <p style={muted}>{m.raised}</p>
                  <p style={{ ...valueText, fontSize: "clamp(24px, 6vw, 40px)", lineHeight: 1.15, fontWeight: 750 }}>{nativeAmount(raised, m.unknown)}</p>
                </div>
                <span style={{ borderRadius: 16, padding: "4px 11px", background: launched ? navy : "#d3dcea",
                  color: launched ? "#f2f6fc" : ink, fontSize: 13, fontWeight: 700 }}>{status}</span>
              </div>
              {progress !== null && (
                <div style={{ display: "grid", gap: 6 }}>
                  <div role="progressbar" aria-label={m.progress} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}
                    style={{ height: 9, background: "#cbd6e6", borderRadius: 8, overflow: "hidden" }}>
                    <div style={{ background: amber, width: progress + "%", height: "100%" }} />
                  </div>
                  <p style={muted}>{progress + "%"} · {m.target} {nativeAmount(target, m.unknown)}</p>
                </div>
              )}
              {!snapshot && <p role="status" style={muted}>{m.noData}</p>}
              <dl style={{ ...columns, margin: 0 }}>
                <Datum label={m.remaining}>{nativeAmount(remaining, m.unknown)}</Datum>
                <Datum label={m.deadline}>{utcTime(deadline, m.unknown)}</Datum>
                <Datum label={m.backstopBuffer}>{usdAmount(bufferUsd, m.unknown)}</Datum>
              </dl>
            </div>

            <dl style={{ ...columns, margin: 0 }}>
              {launched && token && <Datum label={m.issuedToken}>{token}</Datum>}
              {!launched && predicted && <Datum label={m.reservedToken}>{predicted}</Datum>}
              <Datum label={m.splitPool}>{pool ?? (launched ? m.poolPending : m.poolAfterLaunch)}</Datum>
              {vault && <Datum label={m.backstopVault}>{vault}</Datum>}
            </dl>
            <p style={muted}>{m.mechanism}</p>

            {canTransact ? (
              <section style={{ display: "grid", gap: 12, borderBlockStart: `1px solid ${rule}`, paddingBlockStart: 16 }} aria-label={m.participation}>
                <h3 style={{ margin: 0, fontSize: 17 }}>{m.participation}</h3>
                {account && (
                  <dl style={{ ...columns, margin: 0 }}>
                    <Datum label={m.walletAccount}>{shortAddress(account)}</Datum>
                    <Datum label={m.myContribution}>{nativeAmount(contributed, m.unknown)}</Datum>
                    <Datum label={m.myClaimable}>{tokenAmount(claimable, m.tokenUnits, m.unknown)}</Datum>
                    <Datum label={m.myBoost}>{boosted === null ? m.unknown : boosted ? m.boostActive : m.boostNone}</Datum>
                  </dl>
                )}
                {saleOpen && (
                  <>
                    <div style={{ ...columns, alignItems: "end" }}>
                      <Field label={m.contributionAmount} error={amount && !amountValid ? m.amountInvalid : null}>
                        <input name="contribution" value={amount} inputMode="decimal" maxLength={26}
                          disabled={busy || waiting} style={input} onChange={event => editContribution(event.target.value)} />
                      </Field>
                      {remaining !== null && remaining > 0n && (
                        <button type="button" disabled={busy || waiting} style={buttonStyle(busy || waiting, true)}
                          onClick={() => editContribution(exactAmount(remaining))}>{m.fillRemaining}</button>
                      )}
                    </div>
                    <p style={muted}>{m.contributionHelp}</p>
                    {fills && <p style={{ ...muted, fontWeight: 700, color: ink }}>{m.fillsTarget}</p>}
                    <p style={muted}>{boosted === true ? m.boostUsed : m.boostHelp.replace("{amount}", boostEscrowText).replace("{weight}", boostWeightText)}</p>
                  </>
                )}
                {launched && snapshot?.pool === null && seedBalance !== null && seedBalance > 0n && <p style={muted}>{m.openPoolHelp}</p>}
                {refundable && contributed !== null && contributed > 0n && <p style={muted}>{failed ? m.failedHelp : m.refundHelp}</p>}
                {review && (
                  <div style={{ border: `1px solid ${rule}`, borderRadius: 8, padding: 12, display: "grid", gap: 10 }}>
                    <h4 style={{ margin: 0 }}>{options[review.action].label}</h4>
                    <p style={muted}>{reviewStale ? m.reviewChanged : m.confirmReady}</p>
                    {review.action === "contributeBoosted" && <p style={notice}>{m.approveFirst.replace("{amount}", boostEscrowText)}</p>}
                    {review.valueWei && <p style={valueText}>{nativeAmount(asUnits(review.valueWei), m.unknown)}</p>}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button type="button" disabled={busy || reviewStale} style={buttonStyle(busy || reviewStale)} onClick={() => void confirmAction()}>
                        {busy ? m.working : m.confirmTransaction}
                      </button>
                      <button type="button" disabled={busy} style={buttonStyle(busy, true)} onClick={() => setReview(null)}>{m.back}</button>
                    </div>
                  </div>
                )}
                {!review && !waiting && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {!account ? (
                      <button type="button" style={buttonStyle()} onClick={() => host?.wallet?.connect()}>{m.connectWallet}</button>
                    ) : wrongChain ? (
                      <button type="button" disabled={busy} style={buttonStyle(busy)} onClick={() => void switchWalletChain()}>{m.switchChain}</button>
                    ) : visibleActions.length ? visibleActions.map(action => (
                      <button key={action} type="button" disabled={busy || !actionReady(action)}
                        style={buttonStyle(busy || !actionReady(action), action === "contributeBoosted")} onClick={() => startAction(action)}>
                        {busy ? m.working : options[action].label}
                      </button>
                    )) : <p style={muted}>{m.noActions}</p>}
                  </div>
                )}
                {error && <p role="alert" style={notice}>{error}</p>}
                {reportedStatus(receipt, m)}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {waiting && host?.checkReceipt && <button type="button" disabled={busy} style={buttonStyle(busy)}
                    onClick={() => void checkAction()}>{m.checkReceipt}</button>}
                  {host?.refresh && <button type="button" disabled={busy} style={buttonStyle(busy, true)}
                    onClick={() => host?.refresh?.()}>{m.refresh}</button>}
                </div>
              </section>
            ) : <p role="status" style={muted}>{supportsIdentity(identity) ? m.walletBridgeUnavailable : m.factoryMismatch}</p>}

            {launched && token && host?.redirect && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" style={buttonStyle()} onClick={() => openPath("/bnb-testnet/" + token.toLowerCase())}>{m.openToken}</button>
                <p style={muted}>{m.openVault}</p>
                {navigationFailed && <p role="status" style={muted}>{m.openTokenFailed}</p>}
              </div>
            )}
          </>
        ) : <p role="status" style={muted}>{m.noInstance}</p>}
        <details style={{ borderBlockStart: `1px solid ${rule}`, paddingBlockStart: 12 }}>
          <summary style={{ fontWeight: 700, cursor: "pointer" }}>{m.contracts}</summary>
          <dl style={{ margin: "12px 0 0", display: "grid", gap: 12 }}>
            <Datum label={m.factory}>{identity.factoryAddress}</Datum>
            {launcherAddress && <Datum label={m.launcher}>{launcherAddress}</Datum>}
            {vault && <Datum label={m.backstopVault}>{vault}</Datum>}
            {pool && <Datum label={m.splitPool}>{pool}</Datum>}
          </dl>
          <p style={{ ...muted, marginBlockStart: 10 }}>{m.addressesVerified}</p>
        </details>
      </div>
    </section>
  );
}
