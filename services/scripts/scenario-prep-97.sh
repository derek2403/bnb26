#!/usr/bin/env bash
# Put the canonical NVDA ScenarioPool (deployments pools[nvda-scenario]) back to the demo start state for scene 4:
# price at the live Atlas anchor, leverage ~2x, no mUSDC in the pool (so the -55% gap goes under water, CR ~0.91).
#
#   bash services/scripts/scenario-prep-97.sh          (from the repo root or anywhere)
#
# Needs in ./.env: KEEPER_PRIVATE_KEY (team wallet: ScenarioFeed operator + mock MINTER) and REHEARSAL_PRIVATE_KEY
# (the wallet that holds the ScenarioPool sUSD it minted). Stops the keeper for the duration (same team wallet, and
# its rebalance job must not trade the pool mid-prep) and restarts it on exit. Never prints a key.
#
# Steps: feed.reset() -> redeem all REHEARSAL sUSD (drains the mUSDC the sell zone left) -> rebalance() buy zone
# until NONE (mUSDC -> stock) -> mintStable to L ~1.97 (under the 2.05 closed-market cap).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"
set -a; [ -f ./.env ] && . ./.env; set +a
: "${KEEPER_PRIVATE_KEY:?KEEPER_PRIVATE_KEY missing in .env}"
: "${REHEARSAL_PRIVATE_KEY:?REHEARSAL_PRIVATE_KEY missing in .env}"
export ETH_RPC_URL="${BSC_TESTNET_RPC:-https://data-seed-prebsc-1-s1.bnbchain.org:8545}"
ETH_RPC_URL="${ETH_RPC_URL%%,*}"

read -r POOL SUSD FEED ASSET < <(python3 - <<'PY'
import json
d = json.load(open("deployments/97.json"))
p = next(p for p in d["pools"] if p["id"] == "nvda-scenario")
print(p["pool"], p["sUSD"], p["feed"], d["tokens"]["tNVDA"])
PY
)
REH=$(cast wallet address --private-key "$REHEARSAL_PRIVATE_KEY")
STATE='state()((uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool,uint256,int256,uint256,uint256,uint256,uint8,bool,bool,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint256))'
PREVIEW='previewRebalance()((uint8,uint8,uint256,uint256,uint256,uint256,uint256,bool))'
MAXU=115792089237316195423570985008687907853269984665640564039457584007913129639935

# field <idx...>: cast tuple on stdin -> ints (bools as 1/0)
field() { python3 -c '
import sys,re
t=sys.stdin.read().strip(); t=t[1:-1] if t.startswith("(") else t
v=[]
for l in t.split(","):
    l=re.sub(r"\s*\[.*\]","",l).strip(); v.append(1 if l=="true" else 0 if l=="false" else int(l))
print(" ".join(str(v[int(i)]) for i in sys.argv[1:]))' "$@"; }
send() { # send <KEYVAR> <to> <sig> [args...]
  local kv=$1; shift
  cast send "$@" --legacy --gas-price 100000000 --private-key "${!kv}" --json 2>/dev/null \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print("  ", "ok" if d["status"] in ("0x1",1) else "REVERTED", d["transactionHash"])'
  sleep 4
}
show() { cast call "$POOL" "$STATE" | field 0 1 2 12 13 14 | awk '{printf "   C=%.4f U=%.2f S=%.2f L=%.4f CR=%s mode=%s\n",$1/1e18,$2/1e18,$3/1e18,$4/1e18,($5>1e60?"inf":sprintf("%.4f",$5/1e18)),$6}'; }

bash services/scripts/keeper-97.sh stop || true
sleep 8
trap 'bash "$ROOT/services/scripts/keeper-97.sh" start' EXIT

echo "feed.reset()"; send KEEPER_PRIVATE_KEY "$FEED" 'reset()'
show
SB=$(cast call "$SUSD" 'balanceOf(address)(uint256)' "$REH" | awk '{print $1}')
if [ "$SB" != "0" ]; then echo "redeemStable all ($SB)"; send REHEARSAL_PRIVATE_KEY "$POOL" 'redeemStable(uint256,uint256,uint256)' "$SB" 0 0; show; fi
for i in 1 2 3 4 5; do
  read -r Z CD < <(cast call "$POOL" "$PREVIEW" | field 0 6)
  [ "$Z" = "0" ] && break
  [ "$CD" -gt 0 ] && sleep $((CD + 3))
  echo "rebalance() zone=$Z"; send REHEARSAL_PRIVATE_KEY "$POOL" 'rebalance()'; show
done
read -r C P E < <(cast call "$POOL" "$STATE" | field 0 4 10)
B=$(python3 -c "print(max(0, (2*$E - $C*$P//10**18)*10**18//$P) * 985 // 1000)")
MX=$(cast call "$POOL" 'maxMintStable()(uint256)' | awk '{print $1}')
B=$(python3 -c "print(min($B, $MX*99//100))")
BAL=$(cast call "$ASSET" 'balanceOf(address)(uint256)' "$REH" | awk '{print $1}')
if python3 -c "import sys; sys.exit(0 if $BAL < $B else 1)"; then
  echo "mint tNVDA to the rehearsal wallet"; send KEEPER_PRIVATE_KEY "$ASSET" 'mint(address,uint256)' "$REH" "$(python3 -c "print(($B // 10**18 + 5) * 10**18)")"
fi
if [ "$(cast call "$ASSET" 'allowance(address,address)(uint256)' "$REH" "$POOL" | awk '{print $1}')" = "0" ]; then
  send REHEARSAL_PRIVATE_KEY "$ASSET" 'approve(address,uint256)' "$POOL" "$MAXU"
fi
if [ "$B" != "0" ]; then
  echo "mintStable $B"; send REHEARSAL_PRIVATE_KEY "$POOL" 'mintStable(uint256,uint256,uint256)' "$B" 0 $(( $(date +%s) + 1800 ))
fi
echo "ready:"; show
