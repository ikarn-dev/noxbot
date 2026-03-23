# Nox — Solana Memecoin Sniper Bot

A Telegram bot for sniping Solana memecoins with sub-second execution via Jito bundles, KOL wallet intelligence, and automated threat screening.

## Architecture

```
unified-server.js          ← single Node.js process
├── Telegram Bot           (Telegraf — webhook or long-polling)
├── Express API            (REST + SSE live signals)
├── Snipe Engine           (event-driven signal pipeline)
│   ├── Helius Webhook     (real-time on-chain token events)
│   └── DexScreener Poller (new pair discovery every 15s)
├── KOL Scanner            (background wallet tracker)
└── Threat Watchers        (honeypot, LP lock, dev wallet)
```

All subsystems run in **one process** — no PM2, no gRPC, no VPS required.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in BOT_TOKEN, HELIUS_API_KEY, and other values (see .env comments)

# 3. Run locally
npm run dev

# 4. Run in production
npm start
```

## Deployment (Fly.io Free Tier)

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login & launch
fly auth login
fly launch          # uses existing fly.toml
fly secrets import < .env
fly deploy
```

Runs on 256MB RAM, 1 shared CPU. Health check at `/api/health`.

## Environment Variables

All env vars are documented in `.env` with links to where you get each credential:

| Variable | Source |
|---|---|
| `BOT_TOKEN` | [t.me/BotFather](https://t.me/BotFather) |
| `HELIUS_API_KEY` | [dashboard.helius.dev](https://dashboard.helius.dev) |
| `MONGODB_URI` | [cloud.mongodb.com](https://cloud.mongodb.com) |
| `REDIS_URL` | [console.upstash.com](https://console.upstash.com) |

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome + setup wizard |
| `/snipe <token>` | Manual snipe a token |
| `/wallets` | Manage tracked wallets |
| `/settings` | Configure slippage, amounts |
| `/signals` | View recent signal history |
| `/help` | Full command reference |

## Project Structure

```
src/
├── unified-server.js      # Single-process entry point
├── bot/                   # Telegram bot (commands, scenes, middleware)
├── api/                   # Express REST API + SSE
├── streams/               # Data sources (Helius, DexScreener)
├── services/              # Solana RPC, Jupiter swap
├── kol/                   # KOL wallet tracking
├── threat/                # Honeypot, LP lock, dev wallet watchers
├── execution/             # Transaction building & Jito bundles
├── config/                # Redis, Mongo, logger, event bus
├── models/                # Mongoose schemas
└── utils/                 # Helpers (HMAC, formatting)
```

## Tech Stack

- **Runtime**: Node.js 20+
- **Bot**: Telegraf v4
- **API**: Express
- **Database**: MongoDB Atlas (free M0)
- **Cache**: Upstash Redis (free tier)
- **Blockchain**: Helius (RPC + Webhooks + DAS API)
- **Swap**: Jupiter Aggregator v6
- **MEV**: Jito Bundles
