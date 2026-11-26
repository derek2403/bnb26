// Shared (client + server) helpers for the OpenFour fork create flow. Mirrors openfour/startup/scripts/lib/
// schema.js (encodeCreateArgs / encodeModuleParams) and demo.js (signCreate) exactly, ported to viem.
import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseUnits,
  zeroAddress,
  zeroHash,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";

export type ParamDescriptor = {
  name: string;
  abiType: string;
  decimals: number;
  optional: boolean;
  title: string;
  defaultValue: string;
  hint: string;
  minValue: string;
  maxValue: string;
};
export type ModuleSchema = { kind: string; version: number; params: ParamDescriptor[] };
export type PresetSchemas = {
  base: ParamDescriptor[];
  token: ModuleSchema;
  vault: ModuleSchema;
  curve: ModuleSchema;
  trade: ModuleSchema;
  migrate: ModuleSchema;
  customData: ModuleSchema;
};

export const TOKEN_BASE_FALLBACK: ParamDescriptor[] = [
  { name: "name", abiType: "string", decimals: 0, optional: false, title: "Name", defaultValue: "", hint: "", minValue: "", maxValue: "" },
  { name: "symbol", abiType: "string", decimals: 0, optional: false, title: "Symbol", defaultValue: "", hint: "", minValue: "", maxValue: "" },
  { name: "tokenUri", abiType: "string", decimals: 0, optional: true, title: "Metadata URI", defaultValue: "", hint: "", minValue: "", maxValue: "" },
  { name: "maxSupply", abiType: "uint256", decimals: 18, optional: false, title: "Max supply", defaultValue: "1000000000", hint: "", minValue: "", maxValue: "" },
  { name: "saleAmount", abiType: "uint256", decimals: 18, optional: false, title: "Sale amount", defaultValue: "800000000", hint: "", minValue: "", maxValue: "" },
  { name: "raiseAmount", abiType: "uint256", decimals: 18, optional: false, title: "Raise amount (tTSLA)", defaultValue: "10", hint: "", minValue: "", maxValue: "" },
];

export const CREATE_ARGS_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "requestId", type: "uint256" },
      { name: "presetId", type: "uint256" },
      { name: "validTimestamp", type: "uint256" },
      { name: "createFee", type: "uint256" },
      { name: "presaleQuote", type: "uint256" },
      { name: "antiSniperEnabled", type: "bool" },
      { name: "partner", type: "address" },
      {
        name: "initParams",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "tokenUri", type: "string" },
          { name: "maxSupply", type: "uint256" },
          { name: "saleAmount", type: "uint256" },
          { name: "raiseAmount", type: "uint256" },
          { name: "quoteAsset", type: "address" },
          { name: "tokenSalt", type: "bytes32" },
          { name: "tokenParams", type: "bytes" },
          { name: "vaultParams", type: "bytes" },
          { name: "curveParams", type: "bytes" },
          { name: "tradeParams", type: "bytes" },
          { name: "migrateParams", type: "bytes" },
          { name: "customDataParams", type: "bytes" },
        ],
      },
    ],
  },
] as const;

function parseArray(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) throw new Error("array param must be a JSON array");
    return v.map(String);
  }
  return s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}

function zeroValue(t: string): unknown {
  if (t.endsWith("[]")) return [];
  if (t === "address") return zeroAddress;
  if (t === "bool") return false;
  if (t === "bytes32") return zeroHash;
  if (t === "bytes") return "0x";
  if (t === "string") return "";
  return 0n;
}

export function resolveParam(d: ParamDescriptor, form: Record<string, string>): unknown {
  let raw = form[d.name];
  if (raw == null || String(raw).trim() === "") {
    if (d.defaultValue && d.defaultValue.trim() !== "") raw = d.defaultValue;
    else if (d.optional) return zeroValue(d.abiType);
    else throw new Error(`required param "${d.title || d.name}" is missing`);
  }
  const s = String(raw).trim();
  switch (d.abiType) {
    case "address[]":
      return parseArray(s) as Address[];
    case "uint16[]":
      return parseArray(s).map((v) => BigInt(v));
    case "uint256[]":
      return parseArray(s).map((v) => (d.decimals > 0 ? parseUnits(v, d.decimals) : BigInt(v)));
    case "bool":
      return s === "true" || s === "1";
    case "address":
      return (s || zeroAddress) as Address;
    case "string":
      return s;
    case "bytes32":
      return (s || zeroHash) as Hex;
    case "bytes":
      return (s || "0x") as Hex;
    default:
      return d.decimals > 0 ? parseUnits(s, d.decimals) : BigInt(s);
  }
}

export function encodeModuleParams(schema: ModuleSchema | undefined, form: Record<string, string>): Hex {
  if (!schema?.params?.length) return "0x";
  const comps = schema.params.map((p) => ({ type: p.abiType })) as AbiParameter[];
  const values = schema.params.map((p) => resolveParam(p, form));
  return encodeAbiParameters([{ type: "tuple", components: comps }] as AbiParameter[], [values] as unknown[]);
}

export function readBase(form: Record<string, string>, name: string, decimals = 18, fallback = "0"): bigint {
  const raw = (form[name] ?? "").trim() || fallback;
  return decimals > 0 ? parseUnits(raw, decimals) : BigInt(raw);
}

export type CreateInputs = {
  requestId: bigint;
  presetId: bigint;
  validTimestamp: bigint;
  createFee: bigint;
  presaleQuote: bigint;
  quoteAsset: Address;
  /** Fee partner: BackstopTreasury for this preset (zero is also accepted by Core). */
  partner?: Address;
  form: Record<string, string>;
  schemas: PresetSchemas;
};

export function encodeCreateArgs(i: CreateInputs): Hex {
  const f = i.form;
  return encodeAbiParameters(CREATE_ARGS_PARAMS, [
    {
      requestId: i.requestId,
      presetId: i.presetId,
      validTimestamp: i.validTimestamp,
      createFee: i.createFee,
      presaleQuote: i.presaleQuote,
      antiSniperEnabled: false,
      partner: i.partner ?? zeroAddress,
      initParams: {
        name: f.name ?? "",
        symbol: f.symbol ?? "",
        tokenUri: f.tokenUri ?? "",
        maxSupply: readBase(f, "maxSupply"),
        saleAmount: readBase(f, "saleAmount"),
        raiseAmount: readBase(f, "raiseAmount"),
        quoteAsset: i.quoteAsset,
        tokenSalt: zeroHash,
        tokenParams: encodeModuleParams(i.schemas.token, f),
        vaultParams: encodeModuleParams(i.schemas.vault, f),
        curveParams: encodeModuleParams(i.schemas.curve, f),
        tradeParams: encodeModuleParams(i.schemas.trade, f),
        migrateParams: encodeModuleParams(i.schemas.migrate, f),
        customDataParams: encodeModuleParams(i.schemas.customData, f),
      },
    },
  ]);
}

/** Digest Core.signer signs (EIP-191 over the raw 32 bytes), as in openfour/startup/scripts/lib/demo.js. */
export function createDigest(chainId: number, caller: Address, createArgs: Hex): Hex {
  return keccak256(encodePacked(["string", "uint256", "address", "bytes32"], ["createOpenFourToken", BigInt(chainId), caller, keccak256(createArgs)]));
}

/** The EIP-191 message the requesting wallet signs so the server knows the caller controls the address. */
export function requestMessage(chainId: number, caller: Address, requestId: bigint, createArgs: Hex): string {
  return [
    "SplitStock OpenFour create request",
    `chainId: ${chainId}`,
    `caller: ${caller.toLowerCase()}`,
    `requestId: ${requestId.toString()}`,
    `createArgsHash: ${keccak256(createArgs)}`,
  ].join("\n");
}

// Brand blocklist: never let a meme use a listed company's or platform's name (plan: "never put NVIDIA in a meme name").
export const BRAND_BLOCKLIST = [
  "NVIDIA", "NVDA", "GEFORCE", "TESLA", "TSLA", "ELON", "MUSK", "APPLE", "AAPL", "IPHONE", "MICROSOFT", "MSFT",
  "GOOGLE", "GOOGL", "ALPHABET", "AMAZON", "AMZN", "FACEBOOK", "INSTAGRAM", "BROADCOM", "AVGO", "NETFLIX",
  "NFLX", "COINBASE", "MICROSTRATEGY", "MSTR", "BINANCE", "PANCAKESWAP", "COINMARKETCAP", "OPENAI", "ANTHROPIC",
  "SPLITSTOCK", "OPENFOUR", "FOURMEME",
];

export function normalizeBrand(s: string): string {
  return s
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/3/g, "E")
    .replace(/4/g, "A")
    .replace(/5/g, "S")
    .replace(/7/g, "T")
    .replace(/\$/g, "S")
    .replace(/[^A-Z]/g, "");
}

export function brandHit(...values: string[]): string | null {
  for (const v of values) {
    const n = normalizeBrand(v);
    for (const b of BRAND_BLOCKLIST) if (n.includes(b)) return b;
  }
  return null;
}
