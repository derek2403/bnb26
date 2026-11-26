import "server-only";

// Server-only environment. Names match /.env.example; none of these may ever be NEXT_PUBLIC_ (the build fails
// on NEXT_PUBLIC_*KEY, see scripts/check-env.mjs). Values are read lazily so `next build` works without them.
const get = (k: string) => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

export const serverEnv = {
  servicesUrl: () => (get("SERVICES_API_URL") ?? "http://localhost:8080").replace(/\/$/, ""),
  keeperToken: () => get("KEEPER_TOKEN"),
  cmcKey: () => get("CMC_API_KEY"),
  cmcBase: () => (get("CMC_BASE_URL") ?? "https://pro-api.coinmarketcap.com").replace(/\/$/, ""),
  demoPricesTtl: () => Number(get("DEMO_PRICES_TTL_SEC") ?? 600),
  atlasKey: () => get("ATLAS_API_KEY"),
  /** JSON map feed key -> Atlas pull feedId, e.g. {"nvdab":"40215"}. [UNVERIFIED] default id. */
  atlasFeedIds: (): Record<string, string> => {
    // ATLAS_PULL_FEED_ID_NVDA / _TSLA are shared with the deploy scripts (bytes4 hex or decimal registry id);
    // the Atlas API takes the decimal id as a string. ATLAS_PULL_FEED_IDS (JSON) overrides both.
    const dec = (v?: string) => (v ? (v.startsWith("0x") ? BigInt(v).toString() : v) : undefined);
    const out: Record<string, string> = { nvdab: dec(get("ATLAS_PULL_FEED_ID_NVDA")) ?? "40215" };
    const tsla = dec(get("ATLAS_PULL_FEED_ID_TSLA"));
    if (tsla) out.tslab = tsla;
    const raw = get("ATLAS_PULL_FEED_IDS");
    if (raw) {
      try {
        Object.assign(out, JSON.parse(raw) as Record<string, string>);
      } catch {
        /* ignore malformed override */
      }
    }
    return out;
  },
  ofSignerKey: () => get("OF_UI_SIGNER_PRIVATE_KEY") as `0x${string}` | undefined,
  dripKey: () => get("DRIP_PRIVATE_KEY") as `0x${string}` | undefined,
  dripAmountWei: () => BigInt(get("DRIP_AMOUNT_WEI") ?? "5000000000000000"), // 0.005 tBNB
  dripSecret: () => get("DRIP_CHALLENGE_SECRET") ?? get("KEEPER_TOKEN") ?? "splitstock-dev-only",
  testnetRpc: () => get("BSC_TESTNET_RPC") ?? "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  mainnetRpc: () => get("BSC_MAINNET_RPC") ?? "https://bsc-dataseed.bnbchain.org",
};
