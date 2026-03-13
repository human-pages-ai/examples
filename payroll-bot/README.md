# Payroll Bot

Fully autonomous payroll bot that pays humans on [Human Pages](https://humanpages.ai) using Coinbase CDP agentic wallets. No passwords, no manual signing — the agent controls its own wallet.

## Setup

```bash
npm install
cp .env.example .env
```

### 1. Get a Human Pages agent API key

Register at [humanpages.ai/dev](https://humanpages.ai/dev) or via the MCP server, then add your key to `.env`.

### 2. Get CDP credentials

Sign up at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) and create API keys. Add them to `.env`:

```
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_WALLET_SECRET=...
```

### 3. Fund the wallet

```bash
npm run balance
```

This prints the bot's wallet address. Send USDC on Base to that address.

## Usage

```bash
# Pay a human
npm run pay -- --human <humanId> --amount 152.96 --title "Great work!" --description "Thank you for your contributions."

# Check wallet balance
npm run balance
```

The bot will automatically:
1. Load its CDP wallet (keys stored in Coinbase's secure enclaves)
2. Look up the human's wallet address from their Human Pages profile
3. Create a job offer on the platform
4. Send USDC on Base
5. Record the payment on-chain and on the platform

## How it works

- **CDP Agentic Wallet**: Private keys never touch your machine. They live in Coinbase's AWS Nitro Enclaves. The bot signs transactions via API — fully autonomous.
- **Idempotent wallet**: `CDP_WALLET_NAME` maps to a persistent wallet address. Same name = same address across restarts.
- **Human Pages API**: Creates a job record and marks it paid with the on-chain tx hash for verification.
