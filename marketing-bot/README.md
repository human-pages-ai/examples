# Marketing Bot

An autonomous agent that hires humans for social media promotion tasks via the [Human Pages](https://humanpages.ai) platform. It handles the full lifecycle: finding candidates, sending job offers, answering questions, processing payments, and collecting reviews.

## How it works

```
Search candidates → Recommend best fit → Send offer → Chat while waiting
    → Human accepts → Send USDC payment → Wait for completion → Leave review
```

The bot scores candidates by marketing-relevant skills, reputation, and rate, then recommends the best fit. While waiting for the human to accept or complete work, it replies to their messages using an LLM (or keyword fallback if no LLM is configured).

## Quick start

```bash
# Install dependencies
npm install

# Copy the example config and fill in your details
cp .env.example .env

# Run — interactive setup will prompt for project details on first launch
npm run dev
```

On first run the bot will walk you through configuring your project name, URL, social accounts, task description, and price. These are saved to `.env` for future runs.

To re-run setup at any time:

```bash
npm run dev -- --setup
```

## Resuming a job

If the bot stops (crash, timeout, Ctrl+C), resume any existing job by ID:

```bash
npm run dev -- --resume <jobId>
```

The bot fetches the job's current status from the API, loads existing messages, and picks up from the right phase.

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|----------|----------|-------------|
| `API_URL` | Yes | Human Pages API (default: `https://humanpages.ai`) |
| `AGENT_API_KEY` | No | Leave blank to auto-register on first run |
| `PROJECT_NAME` | No | Name of the project you're promoting |
| `PROJECT_URL` | No | URL to drive traffic to |
| `SOCIAL_LINKS` | No | Pipe-separated social accounts (e.g. `X/Twitter: https://x.com/You \| Instagram: https://instagram.com/You`) |
| `ERRAND_DESCRIPTION` | No | Task description sent to marketers |
| `JOB_PRICE_USDC` | No | Payment per job in USDC (default: 20) |
| `PAYMENT_NETWORK` | No | Blockchain network for USDC (default: `base`) |

### Optional features

| Variable | Description |
|----------|-------------|
| `LLM_BASE_URL` | LLM endpoint for smart replies (e.g. `http://localhost:11434` for Ollama) |
| `LLM_MODEL` | Model name (default: `llama3`) |
| `LLM_API_KEY` | API key if your LLM provider requires one |
| `WEBHOOK_URL` | Public URL for real-time event delivery (falls back to polling) |
| `WEBHOOK_SECRET` | HMAC secret for webhook signature verification (16-256 chars) |
| `OWNER_TELEGRAM_BOT_TOKEN` | Telegram bot token for operator notifications |
| `OWNER_TELEGRAM_CHAT_ID` | Telegram chat ID for operator notifications |

## Payments

The bot pays humans in USDC on-chain. Two wallet options:

```bash
# Recommended: encrypted keystore (private key never in plaintext on disk)
npm run generate-keystore

# Alternative: raw private key in .env (testing only)
WALLET_PRIVATE_KEY=0x...
```

Supported networks: Ethereum, Base, Polygon, Arbitrum, Base Sepolia.

## Architecture

```
src/
  index.ts       Entry point — CLI args, candidate selection, setup detection
  bot.ts         Job lifecycle — create offer, chat, pay, review (+ resume)
  responder.ts   Message replies — LLM (Anthropic/OpenAI-compat) + keyword fallback
  webhook.ts     Event polling + optional webhook server
  api.ts         Human Pages API client with retry logic
  pay.ts         USDC payments via viem
  setup.ts       Interactive project configuration
  config.ts      Environment variable loading
  notify.ts      Telegram notifications to bot operator
  prompt.ts      CLI input utilities
  types.ts       TypeScript interfaces
  activate.ts    Agent activation helper

scripts/
  generate-keystore.ts   Encrypted wallet generator
```

## Reply system

The bot answers human messages using a three-tier system:

1. **Anthropic API** — if `LLM_BASE_URL` points to `api.anthropic.com`
2. **OpenAI-compatible API** — any other `LLM_BASE_URL` (Ollama, vLLM, OpenRouter, etc.)
3. **Keyword fallback** — zero-dependency pattern matching when no LLM is configured

The system prompt includes your project name, URL, social accounts, and task details so the LLM can answer questions accurately.

## License

MIT
