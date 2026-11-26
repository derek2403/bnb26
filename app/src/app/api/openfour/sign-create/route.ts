import { decodeAbiParameters, getAddress, isAddress, keccak256, verifyMessage, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addr, deployments97 } from "@/config/deployments";
import { brandHit, CREATE_ARGS_PARAMS, createDigest, requestMessage } from "@/lib/openfour";
import { serverEnv } from "@/lib/server/env";
import { bumpWallet, ofStore, PER_WALLET_DAILY, walletCount } from "@/lib/server/ofStore";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";
import { servicesJson } from "@/lib/server/services";

export const dynamic = "force-dynamic";

// POST /api/openfour/sign-create
// body: { caller, createArgs, requestSignature }
//   requestSignature = EIP-191 personal_sign of requestMessage(97, caller, requestId, createArgs) by `caller`.
// Checks: signed request; presetId == deployments.openfour.presetId; quoteAsset == tTSLA (or openfour.quoteAsset);
// now < validTimestamp <= now + 1h; fresh requestId; brand blocklist (NVIDIA and others); per-wallet + per-IP
// rate limit. Then signs createDigest(97, caller, createArgs) with OF_UI_SIGNER for this caller only.
// Response: { signature, digest, requestId, createFee } -> the wallet calls Core.createToken(createArgs, signature).

const CHAIN_ID = 97;

function bad(error: string, status = 400, extra: Record<string, unknown> = {}) {
  return Response.json({ error, ...extra }, { status });
}

export async function POST(req: Request) {
  const ip = rateLimit(`ofsign:${clientIp(req)}`, 10, 3600);
  if (!ip.ok) return tooMany(ip.retryAfter);

  const signerKey = serverEnv.ofSignerKey();
  const presetId = deployments97.openfour.presetId;
  const quoteAsset = addr(deployments97.openfour.quoteAsset) ?? addr(deployments97.tokens.tTSLA);
  if (!signerKey || presetId === undefined || !quoteAsset || !addr(deployments97.openfour.core)) {
    return bad("openfour_not_configured", 503);
  }

  let body: { caller?: string; createArgs?: string; requestSignature?: string };
  try {
    body = await req.json();
  } catch {
    return bad("invalid_json");
  }
  if (!body.caller || !isAddress(body.caller)) return bad("invalid_caller");
  if (!body.createArgs || !/^0x[0-9a-fA-F]*$/.test(body.createArgs) || body.createArgs.length > 40_000) return bad("invalid_create_args");
  if (!body.requestSignature || !/^0x[0-9a-fA-F]+$/.test(body.requestSignature)) return bad("invalid_request_signature");
  const caller = getAddress(body.caller) as Address;
  const createArgs = body.createArgs as Hex;

  let decoded;
  try {
    [decoded] = decodeAbiParameters(CREATE_ARGS_PARAMS, createArgs);
  } catch {
    return bad("create_args_decode_failed");
  }
  const p = decoded.initParams;
  const now = BigInt(Math.floor(Date.now() / 1000));

  // 1. the caller signed exactly this request
  const message = requestMessage(CHAIN_ID, caller, decoded.requestId, createArgs);
  let ok = false;
  try {
    ok = await verifyMessage({ address: caller, message, signature: body.requestSignature as Hex });
  } catch {
    ok = false;
  }
  if (!ok) return bad("request_signature_mismatch", 401);

  // 2. preset and quote asset are ours
  if (decoded.presetId !== BigInt(presetId)) return bad("wrong_preset", 400, { expected: String(presetId) });
  if (getAddress(p.quoteAsset) !== getAddress(quoteAsset)) return bad("wrong_quote_asset", 400, { expected: quoteAsset });

  // 3. validity window
  if (decoded.validTimestamp <= now || decoded.validTimestamp > now + 3600n) return bad("valid_timestamp_out_of_window");

  // 4. fresh requestId
  const rid = decoded.requestId.toString();
  if (ofStore.requests.has(rid)) return bad("request_id_reused", 409);
  if (decoded.requestId === 0n) return bad("request_id_zero");

  // 5. brand blocklist + basic shape
  if (!p.name.trim() || !p.symbol.trim() || p.name.length > 32 || p.symbol.length > 10) return bad("invalid_name_or_symbol");
  const hit = brandHit(p.name, p.symbol, p.tokenUri);
  if (hit) return bad("brand_blocked", 400, { term: hit });
  if (decoded.antiSniperEnabled) return bad("anti_sniper_not_allowed");
  if (decoded.presaleQuote !== 0n) return bad("presale_not_allowed");
  const treasury = addr(deployments97.openfour.backstopTreasury);
  if (decoded.partner !== zeroAddress && (!treasury || getAddress(decoded.partner) !== getAddress(treasury))) return bad("partner_must_be_backstop_treasury");

  // 6. per-wallet limit
  if (walletCount(caller) >= PER_WALLET_DAILY) return bad("wallet_daily_limit", 429);

  const account = privateKeyToAccount(signerKey);
  const digest = createDigest(CHAIN_ID, caller, createArgs);
  const signature = await account.signMessage({ message: { raw: digest } });

  bumpWallet(caller);
  const record = { requestId: rid, caller, name: p.name, symbol: p.symbol, createArgsHash: keccak256(createArgs), signedAt: Date.now() };
  ofStore.requests.set(rid, record);
  void servicesJson("openfour/records", { method: "POST", body: JSON.stringify({ type: "signed", ...record }) });

  return Response.json({ signature, digest, requestId: rid, createFee: decoded.createFee.toString(), signer: account.address });
}
