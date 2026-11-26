import { concat, keccak256, type Hex } from "viem";

/**
 * Merkle tree over log entry hashes (leaves = entryHash, in seq order).
 *   parent = keccak256(left ‖ right)          (ordered, not sorted: position matters)
 *   odd node at the end of a level is promoted unchanged (no self-duplication, so no CVE-2012-2459 ambiguity)
 *   a single leaf is its own root
 * The same rule is implemented in the app's browser verifier (/proof) and in `cli verify-snapshot`.
 */
export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) throw new Error("merkleRoot: no leaves");
  let level = leaves.slice();
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(keccak256(concat([level[i], level[i + 1]])));
      else next.push(level[i]);
    }
    level = next;
  }
  return level[0];
}

export interface ProofStep {
  sibling: Hex;
  /** true when the sibling sits on the left: parent = keccak(sibling ‖ node) */
  left: boolean;
}

export function merkleProof(leaves: Hex[], index: number): ProofStep[] {
  if (index < 0 || index >= leaves.length) throw new Error("merkleProof: index out of range");
  const proof: ProofStep[] = [];
  let level = leaves.slice();
  let idx = index;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        if (i === idx) proof.push({ sibling: level[i + 1], left: false });
        else if (i + 1 === idx) proof.push({ sibling: level[i], left: true });
        next.push(keccak256(concat([level[i], level[i + 1]])));
      } else {
        next.push(level[i]); // promoted, no proof step
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

export function verifyProof(leaf: Hex, proof: ProofStep[], root: Hex): boolean {
  let node = leaf;
  for (const s of proof) node = s.left ? keccak256(concat([s.sibling, node])) : keccak256(concat([node, s.sibling]));
  return node.toLowerCase() === root.toLowerCase();
}
