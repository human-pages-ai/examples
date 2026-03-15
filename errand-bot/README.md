# Sample Bot: Local Errand Bot

A minimal, runnable example showing how to build a bot on Human Pages. This bot demonstrates Human Pages' core value proposition: **giving AI agents hands in the physical world** by hiring nearby humans for real-world tasks.

## The Idea

AI can write code, analyze data, and generate text — but it can't pick up a package, check if a store is open, or deliver a document across town. Human Pages bridges that gap. This sample bot finds available humans near a location and hires one to run an errand.

## Prerequisites

- Node.js 18+ (for built-in `fetch`)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment
cp .env.example .env
# Edit .env — set API_URL and errand description

# 3. Run the bot (pass a human ID from the platform)
npx tsx src/index.ts <humanId>
```

That's it — no webhook server, no tunnel, no extra infrastructure. The bot polls the API for status changes and messages.

### Adding Smart Replies

By default the bot uses simple keyword matching. To enable AI-powered conversation, add any LLM:

```bash
# Local model (free — Ollama, LM Studio, etc.)
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=llama3

# — or any cloud provider with a free tier —

# OpenRouter (free models available)
LLM_BASE_URL=https://openrouter.ai/api
LLM_API_KEY=sk-or-...
LLM_MODEL=google/gemma-2-9b-it:free

# Google Gemini (free tier)
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_API_KEY=AIza...
LLM_MODEL=gemini-2.0-flash
```

See [Connecting an LLM](#connecting-an-llm) for all options.

## What It Does

The bot demonstrates the full Human Pages REST API lifecycle:

```
Register → Search/Fetch human → Offer → Message → Wait for acceptance → Pay → Wait for completion → Review
```

> **Tip:** If no humans match your search, post a job listing on the Human Pages job board via `POST /api/listings` and let qualified humans come to you. See the [marketing-bot](../marketing-bot/) for an example with `--post-listing`.

### Step-by-Step

1. **Register** — `POST /api/agents/register` creates an agent identity and returns an API key. The agent is auto-activated on PRO tier (free during launch) and ready to use immediately. Skipped if `AGENT_API_KEY` is already set in `.env`.

2. **Fetch human** — `GET /api/humans/:id` fetches the target human's public profile.

3. **Offer** — `POST /api/jobs` sends a job offer describing the physical task, with a price.

4. **Message** — `POST /api/jobs/:id/messages` sends an intro message to the human.

5. **Wait for acceptance** — Polls `GET /api/jobs/:id` every 5 seconds. While waiting, the bot also polls for new messages and replies to them, so the human can ask questions before accepting. If contact info is not in the acceptance payload, the bot fetches it via `GET /api/humans/:id/profile`.

6. **Coordinate** — Sends a coordination message to the human.

7. **Pay** — If a wallet is configured, fetches the human's wallet address via `GET /api/humans/:id/profile` (required since the public endpoint no longer returns wallets), sends real USDC on-chain via `pay.ts`, and calls `PATCH /api/jobs/:id/paid` with the confirmed tx hash. Without a wallet, uses a placeholder (demo mode).

8. **Wait for completion** — Continues polling status and replying to messages while the human works.

9. **Review** — `POST /api/jobs/:id/review` leaves a rating and comment.

**Note:** `AGENT_API_KEY` from registration works immediately -- agents are auto-activated on PRO tier (free during launch). No manual activation needed.

If a `WEBHOOK_URL` is configured, the bot uses real-time webhooks instead of polling.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Description |
|----------|-------------|
| `API_URL` | Human Pages API base URL |
| `AGENT_API_KEY` | Saved API key (leave blank to auto-register; key works immediately, no activation needed) |
| `AGENT_NAME` | Bot name for registration |
| `LLM_BASE_URL` | Any OpenAI-compatible endpoint (see below) |
| `LLM_API_KEY` | API key for the LLM provider (if required) |
| `LLM_MODEL` | Model name (e.g. `llama3`, `gemini-2.0-flash`) |
| `LLM_SYSTEM_PROMPT` | Custom system prompt (optional) |
| `OWNER_TELEGRAM_BOT_TOKEN` | Telegram bot token for owner alerts (optional) |
| `OWNER_TELEGRAM_CHAT_ID` | Your Telegram chat ID for alerts (optional) |
| `WEBHOOK_PORT` | Port for the webhook server (default: 4000) |
| `WEBHOOK_URL` | Public URL the platform uses to reach webhooks (optional) |
| `WEBHOOK_SECRET` | Shared secret for HMAC-SHA256 signature verification |
| `ERRAND_DESCRIPTION` | What the human needs to do in the physical world |
| `JOB_PRICE_USDC` | Price offered in USDC |
| `CDP_API_KEY_ID` | Coinbase Developer Platform API key ID (recommended wallet option) |
| `CDP_API_KEY_SECRET` | CDP API key secret |
| `CDP_WALLET_SECRET` | CDP wallet encryption secret |
| `CDP_WALLET_NAME` | CDP wallet name (default: `errand-bot`) |
| `WALLET_PRIVATE_KEY` | Wallet private key for USDC payments (alternative to CDP) |
| `PAYMENT_NETWORK` | Blockchain network for payments (default: `base-sepolia`) |
| `MAX_PER_TRANSACTION` | Guardrail: max USDC per payment (default: `50`) |
| `MAX_DAILY_SPEND` | Guardrail: max USDC per 24h (default: `100`) |
| `REQUIRE_APPROVAL_ABOVE` | Guardrail: prompt operator above this amount (default: `25`) |

## Payment

The bot can send real USDC on-chain to pay humans. Without a wallet configured, it runs in demo mode with a placeholder transaction.

### Wallet Options

| Option | Private key on disk? | Setup | Best for |
|--------|---------------------|-------|----------|
| **CDP wallet** (recommended) | No — keys in Coinbase secure enclaves | 3 env vars from [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) | Production, autonomous bots |
| **Encrypted keystore** | Encrypted (password at startup) | `npm run generate-keystore` | Mainnet with manual oversight |
| **Raw private key** | Yes (plaintext in `.env`) | `WALLET_PRIVATE_KEY=0x...` | Testnet, local dev |

The bot auto-detects which wallet to use in priority order: CDP > keystore > env var.

### CDP Wallet Setup (Recommended)

CDP (Coinbase Developer Platform) wallets keep private keys in Coinbase's secure enclaves. Your bot never touches a raw private key.

1. **Create API credentials** at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com)
2. **Add to `.env`**:
   ```bash
   CDP_API_KEY_ID=your-key-id
   CDP_API_KEY_SECRET=your-key-secret
   CDP_WALLET_SECRET=your-wallet-secret
   CDP_WALLET_NAME=errand-bot
   ```
3. **Fund the wallet** — run the bot once to see the wallet address, then send USDC + gas to it.

The wallet is persistent: same `CDP_WALLET_NAME` gives the same address every time.

### Testnet Setup (Raw Key)

1. **Get a wallet** — any Ethereum wallet (MetaMask, etc.). Export the private key.
2. **Get testnet ETH** — visit [Base Sepolia Faucet](https://www.alchemy.com/faucets/base-sepolia) for gas.
3. **Get testnet USDC** — visit [Circle Faucet](https://faucet.circle.com) → select Base Sepolia.
4. **Configure** — add to `.env`:
   ```bash
   WALLET_PRIVATE_KEY=0x...
   PAYMENT_NETWORK=base-sepolia
   ```

### Encrypted Keystore

```bash
npm run generate-keystore
# Prompts for private key + password → writes keystore.json
# At startup the bot prompts for password — key never on disk in plaintext
```

### Switching to Mainnet

Change `PAYMENT_NETWORK` to the desired network and fund your wallet with real USDC + gas:

| Network | `PAYMENT_NETWORK` value |
|---------|------------------------|
| Base | `base` |
| Ethereum | `ethereum` |
| Polygon | `polygon` |
| Arbitrum | `arbitrum` |
| Base Sepolia (testnet) | `base-sepolia` |

### Security Guardrails

Every payment goes through code-enforced guardrails before it reaches the chain. These are not documentation-only promises -- they are runtime checks that block transactions.

| Guardrail | Default | Env var | Behavior |
|-----------|---------|---------|----------|
| **Max per transaction** | $50 | `MAX_PER_TRANSACTION` | Hard block, no override |
| **Daily spend limit** | $100/24h | `MAX_DAILY_SPEND` | Hard block, resets on rolling 24h window |
| **Recipient allowlist** | API-only | (automatic) | Only addresses fetched from Human Pages API |
| **Approval prompt** | >$25 | `REQUIRE_APPROVAL_ABOVE` | Operator must type "yes" on stdin |

Transactions are logged to `.guardrails-ledger.json` with timestamp, amount, recipient, and tx hash.

### How It Works

When a wallet is configured, Step 8 of the bot lifecycle:
1. Loads your wallet (CDP, keystore, or env var)
2. Checks your USDC balance on the payment network
3. Looks up the human's wallet address for that network
4. Runs guardrail checks (amount limits, daily cap, recipient allowlist)
5. Prompts for approval if above threshold
6. Sends USDC on-chain (ERC-20 transfer for viem, native transfer for CDP)
7. Records the transaction in the guardrails ledger
8. Reports the confirmed tx hash to the platform

## Project Structure

```
src/
├── config.ts      — Environment variable loading and validation
├── types.ts       — TypeScript interfaces for API responses and webhooks
├── api.ts         — Human Pages API client (fetch + retry with backoff)
├── pay.ts         — On-chain USDC payment (CDP wallet or viem + keystore/env)
├── guardrails.ts  — Payment guardrails (spend limits, allowlist, approval prompts)
├── responder.ts   — LLM reply generation (any provider or keyword fallback)
├── notify.ts      — Owner Telegram notifications
├── webhook.ts     — Webhook server + polling fallback for status & messages
├── bot.ts         — Main orchestration logic (the lifecycle above)
└── index.ts       — Entry point
scripts/
└── generate-keystore.ts — Encrypt a private key into keystore.json
```

## Connecting an LLM

The bot uses the **OpenAI chat completions format** (`/v1/chat/completions`), which is the de facto standard supported by virtually every LLM provider. Just set `LLM_BASE_URL` and optionally `LLM_API_KEY`:

### Local Models (free, private)

| Provider | LLM_BASE_URL | LLM_MODEL |
|----------|-------------|-----------|
| [Ollama](https://ollama.com) | `http://localhost:11434` | `llama3` |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234` | (auto) |
| [vLLM](https://github.com/vllm-project/vllm) | `http://localhost:8000` | your-model |
| [LocalAI](https://localai.io) | `http://localhost:8080` | your-model |

No `LLM_API_KEY` needed for local models.

### Cloud Providers (free tiers available)

| Provider | LLM_BASE_URL | LLM_API_KEY | LLM_MODEL |
|----------|-------------|-------------|-----------|
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api` | `sk-or-...` | `google/gemma-2-9b-it:free` |
| [Google Gemini](https://ai.google.dev) | `https://generativelanguage.googleapis.com/v1beta/openai` | `AIza...` | `gemini-2.0-flash` |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) | `https://api.cloudflare.com/client/v4/accounts/{id}/ai` | CF token | `@cf/meta/llama-3-8b-instruct` |
| [Groq](https://groq.com) | `https://api.groq.com/openai` | `gsk_...` | `llama-3.3-70b-versatile` |
| [Together](https://together.ai) | `https://api.together.xyz` | `tok_...` | `meta-llama/Llama-3-8b-chat-hf` |
| [Fireworks](https://fireworks.ai) | `https://api.fireworks.ai/inference` | `fw_...` | `accounts/fireworks/models/llama-v3-8b-instruct` |

### Anthropic (native API)

Anthropic uses a different request format, which is auto-detected from the URL:

```bash
LLM_BASE_URL=https://api.anthropic.com
LLM_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-4-5-20250929
```

### Custom System Prompt

Override the built-in prompt for any provider:

```bash
LLM_SYSTEM_PROMPT="You are a delivery coordinator. Be brief and professional. Never reveal you are an AI."
```

## Owner Notifications (Telegram)

Optionally receive Telegram alerts when the bot needs attention:

- Job accepted / rejected / completed
- Human sends a message (with content preview)
- LLM errors (so you know replies fell back to keywords)

### Setup

1. **Create a Telegram bot**: Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. Copy the token.

2. **Get your chat ID**: Message [@userinfobot](https://t.me/userinfobot) — it replies with your chat ID.

3. **Add to `.env`**:
   ```bash
   OWNER_TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
   OWNER_TELEGRAM_CHAT_ID=123456789
   ```

4. **Start your bot**: Message your new bot once on Telegram (required before it can send you messages).

## Key Patterns

### No Webhook Required

The bot works out of the box by polling. It checks job status and messages every 5 seconds. If you configure `WEBHOOK_URL`, it switches to real-time webhook delivery instead.

### Message Handling During Waits

While waiting for acceptance or completion, the bot simultaneously monitors for new messages and replies. This lets the human ask questions, negotiate, or coordinate without breaking the flow.

### Authentication

All API requests include the `X-Agent-Key` header:

```ts
headers['X-Agent-Key'] = apiKey;
```

### Retry with Backoff

The API client retries failed requests with exponential backoff (`1s → 4s → 16s`), but never retries 4xx client errors since those won't succeed on retry.

### Webhook Signature Verification

When using webhooks, the platform signs payloads with HMAC-SHA256 using your `callbackSecret`. The bot verifies signatures using `crypto.timingSafeEqual` (not `===`) to prevent timing attacks:

```ts
const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
```

## Customizing

This bot hires humans for errands, but you can adapt it to any physical-world task:

- **Property scout** — find humans near a listing, ask them to photograph it
- **Mystery shopper** — search near a restaurant, hire someone to evaluate service
- **Equipment check** — filter by `equipment` (e.g., humans with a camera or measuring tools)
- **Local translator** — filter by `language` instead of location for in-person translation

To build your own:

1. Fork this example
2. Change the errand description and price
3. Customize the system prompt in `LLM_SYSTEM_PROMPT` (or modify `responder.ts`)
4. Configure payment (see [Payment](#payment) above)
5. Deploy with a webhook URL for real-time events

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run with tsx (TypeScript, no build step) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled JavaScript from `dist/` |
| `npm run generate-keystore` | Encrypt a private key into `keystore.json` |
