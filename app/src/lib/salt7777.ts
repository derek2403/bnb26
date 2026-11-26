// Client-side miner for a Flap launch salt whose token address ends in 0x7777.
// Same rule as contracts/script/FlapLaunch.s.sol `_mineSalt`: salt_i = keccak256(seed ‖ i), and the token is the
// OpenZeppelin EIP-1167 clone CREATE2(deployer = Portal, salt, initcode(FLAP_TOKEN_IMPL)).
import { concat, hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";

/** Flap's tax-token implementation on BSC testnet (contracts/src/launch/ISplitLaunch.sol FLAP_TOKEN_IMPL). */
export const FLAP_TOKEN_IMPL: Address = "0x7777c57ff7dc441c1715b2e36fa581c48B782222";

/** OZ Clones init code: 3d602d80600a3d3981f3 ‖ 363d3d373d3d3d363d73 ‖ impl ‖ 5af43d82803e903d91602b57fd5bf3 */
export function cloneInitCodeHash(impl: Address = FLAP_TOKEN_IMPL): Hex {
  return keccak256(concat(["0x3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, "0x5af43d82803e903d91602b57fd5bf3"]));
}

export function predictCloneAddress(deployer: Address, salt: Hex, impl: Address = FLAP_TOKEN_IMPL): Address {
  const h = keccak256(concat(["0xff", deployer, salt, cloneInitCodeHash(impl)]));
  return `0x${h.slice(-40)}` as Address;
}

export function randomSeed(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}

/**
 * Mine a salt. Runs in chunks and yields to the event loop between them so the UI stays responsive.
 * ~65,536 tries on average (1 in 2^16).
 */
export async function mineSalt7777(
  portal: Address,
  opts: { seed?: Hex; chunk?: number; onProgress?: (tries: number) => void; signal?: AbortSignal; impl?: Address } = {},
): Promise<{ salt: Hex; token: Address; tries: number }> {
  const seed = hexToBytes(opts.seed ?? randomSeed());
  const chunk = opts.chunk ?? 4000;
  // preimage for salt: seed(32) ‖ i(32)
  const pre = new Uint8Array(64);
  pre.set(seed, 0);
  // CREATE2 preimage: 0xff(1) ‖ deployer(20) ‖ salt(32) ‖ initHash(32)
  const buf = new Uint8Array(85);
  buf[0] = 0xff;
  buf.set(hexToBytes(portal), 1);
  buf.set(hexToBytes(cloneInitCodeHash(opts.impl)), 53);

  for (let i = 0; ; ) {
    const end = i + chunk;
    for (; i < end; i++) {
      // write i as a big-endian uint256 (fits in 53 bits)
      let v = i;
      for (let k = 63; k >= 32; k--) {
        pre[k] = v & 0xff;
        v = Math.floor(v / 256);
      }
      const salt = keccak256(pre, "bytes");
      buf.set(salt, 21);
      const h = keccak256(buf, "bytes");
      if (h[30] === 0x77 && h[31] === 0x77) {
        return { salt: toHex(salt), token: `0x${toHex(h.slice(12)).slice(2)}` as Address, tries: i + 1 };
      }
    }
    opts.onProgress?.(i);
    if (opts.signal?.aborted) throw new Error("Cancelled");
    await new Promise((r) => setTimeout(r, 0));
  }
}
