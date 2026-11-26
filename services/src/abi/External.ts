// HAND-WRITTEN ABIs for external contracts we do not build (Atlas, Flap, OpenFour Core, PCS v2, ERC20, ERC-8004).
import { parseAbi } from "viem";

/** Atlas SingleFeed (Chainlink AggregatorV3-compatible). Mainnet NVDAB/USD: 0xf25af12920d408baf6211e9e90eda89df3d8ccda. */
export const atlasSingleFeedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

/** topic0 the Atlas SingleFeed emits on every update (observed via eth_getLogs, 26 Nov 2026). */
export const ATLAS_SINGLEFEED_UPDATE_TOPIC0 =
  "0x2bc717c424b344a33f86f9122ab9a958f06a0a9258688309fc5f9c4313db5019" as const;

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const uniswapV2PairAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

/** Flap tax token -> TaxProcessor. [UNVERIFIED getter name] the processor address should come from deployments
 *  flap.launchers[].taxProcessor; `taxProcessor()` is only a best-effort fallback read. */
export const flapTaxTokenAbi = parseAbi(["function taxProcessor() view returns (address)"]);
export const flapTaxProcessorAbi = parseAbi(["function dispatch()"]);

/** OpenFour Core: permissionless graduation. */
/** `migrate(token)` is the plan's permissionless graduation entry point [UNVERIFIED name: not in the public
 *  IOpenFourCore interface]; the poker only sends it after an eth_call simulation succeeds. The event matches
 *  openfour/startup/contracts/interfaces/IOpenFourCore.sol. */
export const openFourCoreAbi = parseAbi([
  "function migrate(address token)",
  "event MigrateExecuted(uint256 indexed presetId, address indexed caller, address indexed token, address vault, address migrateModule, bytes8 migrateTagId, uint256 totalRaised, uint256 remainingForSale, bytes32 hookDataHash, uint8 migratedDataVersion, bytes encodedMigratedData)",
]);

/** ERC-8004 ReputationRegistry feedback [UNVERIFIED signature; only used by `cli agent feedback`]. */
export const erc8004ReputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

/** ERC-8004 IdentityRegistry (ERC-721 based). [UNVERIFIED] exact signatures beyond register/setAgentWallet. */
export const erc8004IdentityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
