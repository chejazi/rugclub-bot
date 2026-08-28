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
# From rug-contracts/
PROTOCOL_ADDRESS=0x0b864645E13C2DDd47CbA46FDd918a9f85d11065 \
TIP_OPERATOR=0x005EF7B305e6CE5465d66607e31516c242FB09b5 \
forge script script/DeployTipDistributor.s.sol:DeployTipDistributor \
  --rpc-url base --account deployer --broadcast --verify
```

Then set `TIP_DISTRIBUTOR_ADDRESS` / `NEXT_PUBLIC_TIP_DISTRIBUTOR_ADDRESS`, fund the operator with ETH for gas, send tip-token inventory to the distributor, and fill Neynar env vars.

Simulation (no broadcast) already succeeded against live Protocol `getCurrentToken()` = `0xc9D906309dC15b4CC15281ae1a361c04a73AFB8e`.

## PM2 (keep the bot running)

From the bot directory on the EC2 host (deps and `.env` already in place):

```bash
cd /path/to/rugclub/rug-bot
npm install
pm2 start npm --name rugclub-bot -- start
```

Or start the file directly:

```bash
pm2 start "npx tsx src/index.ts" --name rugclub-bot
```

PM2 restarts the process if it crashes.

### Useful commands

```bash
pm2 status
pm2 logs rugclub-bot
pm2 restart rugclub-bot
pm2 stop rugclub-bot
```
