import { decodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { creatorRegistrarAbi, openFourCoreAbi, splitPoolMigrateModuleAbi } from "../abi/index.js";
import { testnet } from "../config/deployments.js";
import { publicClient, signer } from "../lib/chains.js";
import { kvGet, kvSet } from "../lib/db.js";
import { errMsg } from "../lib/log.js";
import { sendTx, simulate } from "../lib/tx.js";
import { MIN, type Job } from "./types.js";

/**
 * openfour-poker (1 min): keeps holders from being stranded. For each SplitStock OpenFour token, polls the
 * migrate module's previewGraduation(token); once canMigrate is true it simulates and sends Core.migrate(token)
 * from K_OPS (a non-team wallet, as the Four.meme track asks). If the per-token migrate module still lacks
 * PoolFactory CREATOR_ROLE, it first calls the permissionless CreatorRegistrar.registerOpenFourToken(core, token)
 * (core.creatorRegistrar; works after the Timelock handoff once ConfigureRegistrar allowlisted the preset).
 *
 * previewGraduation(token) returns the module's SplitPoolPreview struct (canMigrate, reason, …) per the compiled
 * ABI in src/abi/SplitPoolMigrateModule.ts; older drafts returning MigrateResult {canMigrate, data, reason} or a bare
 * bool are decoded from raw returndata as a fallback.
 */
const previewSel = parseAbi(["function previewGraduation(address token) view returns (bool)"]);

type Preview = { canMigrate: boolean; reason?: string; hasCreatorRole?: boolean; migrated?: boolean };

async function preview(module: Address, token: Address): Promise<Preview | undefined> {
  const c = publicClient("testnet");
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pv = (await c.readContract({ address: module, abi: splitPoolMigrateModuleAbi, functionName: "previewGraduation" as any, args: [token] as any })) as unknown;
    if (pv && typeof pv === "object" && "canMigrate" in pv) {
      const o = pv as { canMigrate: boolean; reason?: string; migrated?: boolean; hasCreatorRole?: boolean };
      return {
        canMigrate: Boolean(o.canMigrate),
        reason: o.migrated ? "already migrated" : o.reason,
        hasCreatorRole: o.hasCreatorRole,
        migrated: o.migrated,
      };
    }
  } catch {
    /* fall back to raw decoding */
  }
  try {
    const { data } = await c.call({ to: module, data: encodeFunctionData({ abi: previewSel, functionName: "previewGraduation", args: [token] }) });
    if (!data || data === "0x") return undefined;
    try {
      const [r] = decodeAbiParameters([{ type: "tuple", components: [{ name: "canMigrate", type: "bool" }, { name: "data", type: "bytes" }, { name: "reason", type: "string" }] }], data as Hex);
      return { canMigrate: r.canMigrate, reason: r.reason };
    } catch {
      const [b] = decodeAbiParameters([{ type: "bool" }], data as Hex);
      return { canMigrate: b };
    }
  } catch {
    return undefined;
  }
}

/** CreatorRegistrar.registerOpenFourToken(core, token) when the registrar is deployed and allowlists the preset. */
async function ensureCreatorRole(s: NonNullable<ReturnType<typeof signer>>, core: Address, token: Address, dryRun: boolean) {
  const registrar = testnet()?.core?.creatorRegistrar as Address | undefined;
  if (!registrar || /^0x0{40}$/i.test(registrar)) return undefined;
  const c = publicClient("testnet");
  try {
    const [presetId] = await c.readContract({ address: registrar, abi: creatorRegistrarAbi, functionName: "openFourModuleOf", args: [core, token] });
    const allowed = await c.readContract({ address: registrar, abi: creatorRegistrarAbi, functionName: "openFourPresetAllowed", args: [core, presetId] });
    if (!allowed) return { ok: false, reason: `preset ${presetId} not allowlisted on CreatorRegistrar` };
  } catch (e) {
    return { ok: false, reason: errMsg(e) };
  }
  const r = await sendTx(s, "openfour-poker", { address: registrar, abi: creatorRegistrarAbi, functionName: "registerOpenFourToken", args: [core, token] }, { dryRun });
  return { ok: r.ok, tx: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) };
}

export async function pokeOnce(dryRun = false) {
  const d = testnet();
  const of = d?.openfour;
  if (!of?.core) return [{ skipped: "no openfour.core in deployments" }];
  const s = signer("ops");
  const out: Record<string, unknown>[] = [];
  for (const t of of.tokens ?? []) {
    if (!t.token) continue;
    const doneKey = `openfour:migrated:${t.token.toLowerCase()}`;
    if (await kvGet<boolean>(doneKey)) continue;
    const module = t.migrateModule ?? of.migrateModule;
    let pv = module ? await preview(module, t.token) : undefined;
    if (pv && pv.hasCreatorRole === false && !pv.migrated && s) {
      const reg = await ensureCreatorRole(s, of.core, t.token, dryRun);
      if (reg) out.push({ token: t.token, creatorRegistrar: reg });
      if (reg?.ok && !dryRun && module) pv = await preview(module, t.token);
    }
    if (pv && !pv.canMigrate) {
      out.push({ token: t.token, canMigrate: false, reason: pv.reason });
      continue;
    }
    if (!s) {
      out.push({ token: t.token, skipped: "OPS_PRIVATE_KEY not set", canMigrate: pv?.canMigrate });
      continue;
    }
    // previewGraduation unavailable -> rely on the simulation alone
    const sim = await simulate(s, { address: of.core, abi: openFourCoreAbi, functionName: "migrate", args: [t.token] });
    if (!sim.ok) {
      out.push({ token: t.token, canMigrate: pv?.canMigrate, simulation: sim.revert ?? sim.error });
      continue;
    }
    try {
      const r = await sendTx(s, "openfour-poker", { address: of.core, abi: openFourCoreAbi, functionName: "migrate", args: [t.token] }, { dryRun, note: { poolId: t.poolId } });
      if (r.ok && !dryRun) await kvSet(doneKey, true);
      out.push({ token: t.token, migrated: r.ok, tx: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) });
    } catch (e) {
      out.push({ token: t.token, error: errMsg(e) });
    }
  }
  return out;
}

export const openfourPokerJob: Job = { name: "openfour", everyMs: MIN, run: (ctx) => pokeOnce(ctx.dryRun) };
