# Rug Club tip bot

Express service for Farcaster tips (`X $TICKER` replies), TipDistributor settlement, and address→ENS/FID resolve cache.

## Setup

```bash
cp .env.example .env
# fill BASE_RPC_URL, PROTOCOL_ADDRESS, TIP_DISTRIBUTOR_ADDRESS, TIP_OPERATOR_KEY, NEYNAR_*
npm install
npm run dev
```

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness + cycle summary |
| GET | `/allocations` | All tip allocations (weight = commit × streak; ENS included) |
| GET | `/allocations/:address` | Single address allocation + ENS |
| GET | `/resolve/:address` | Cached ENS / FID / username |
| POST | `/webhook/neynar` | Neynar `cast.created` ingest |
| GET | `/tips/status/:castHash` | Cast tip status (`processed` / `pending` / `unknown`) |
| POST | `/tips/replay` | Replay missed cast (`{ castHash }`, optional `x-tip-bot-secret`) |

## Deploy

```bash
# From contracts/
PROTOCOL_ADDRESS=0x0b864645E13C2DDd47CbA46FDd918a9f85d11065 \
TIP_OPERATOR=0x005EF7B305e6CE5465d66607e31516c242FB09b5 \
forge script script/DeployTipDistributor.s.sol:DeployTipDistributor \
  --rpc-url base --account deployer --broadcast --verify
```

Then set `TIP_DISTRIBUTOR_ADDRESS` / `NEXT_PUBLIC_TIP_DISTRIBUTOR_ADDRESS`, fund the operator with ETH for gas, send tip-token inventory to the distributor, and fill Neynar env vars.

Simulation (no broadcast) already succeeded against live Protocol `getCurrentToken()` = `0xc9D906309dC15b4CC15281ae1a361c04a73AFB8e`.
