import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  // API
  apiUrl: required('API_URL'),
  agentApiKey: process.env.AGENT_API_KEY || '',

  // Agent registration (used if agentApiKey is blank)
  agentName: optional('AGENT_NAME', 'Marketing Bot'),
  agentDescription: optional(
    'AGENT_DESCRIPTION',
    'Hires humans for social media promotion and marketing tasks',
  ),
  agentContactEmail: process.env.AGENT_CONTACT_EMAIL || undefined,

  // Webhook
  webhookPort: parseInt(optional('WEBHOOK_PORT', '4000'), 10),
  webhookHost: optional('WEBHOOK_HOST', '0.0.0.0'),
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // LLM (optional — enables smart replies instead of keyword matching)
  llmBaseUrl: process.env.LLM_BASE_URL || '',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: optional('LLM_MODEL', 'llama3'),
  llmSystemPrompt: process.env.LLM_SYSTEM_PROMPT || '',

  // Telegram notifications to the bot owner (optional)
  ownerTelegramBotToken: process.env.OWNER_TELEGRAM_BOT_TOKEN || '',
  ownerTelegramChatId: process.env.OWNER_TELEGRAM_CHAT_ID || '',

  // Payment
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',
  paymentNetwork: optional('PAYMENT_NETWORK', 'base'),

  // Project being promoted
  projectName: optional('PROJECT_NAME', 'our project'),
  projectUrl: process.env.PROJECT_URL || '',
  socialLinks: process.env.SOCIAL_LINKS || '',

  // Marketing task params
  errandDescription: optional(
    'ERRAND_DESCRIPTION',
    'Promote our project on your social media channels — share posts with your honest take.',
  ),
  jobPriceUsdc: parseFloat(optional('JOB_PRICE_USDC', '20')),
};

// Validate webhook secret length (platform requires 16-256 chars) — only if webhook is configured
if (config.webhookSecret && (config.webhookSecret.length < 16 || config.webhookSecret.length > 256)) {
  throw new Error('WEBHOOK_SECRET must be between 16 and 256 characters');
}
