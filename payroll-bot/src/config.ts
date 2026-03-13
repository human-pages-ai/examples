import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  apiUrl: required('API_URL'),
  agentApiKey: required('AGENT_API_KEY'),
  cdpApiKeyId: required('CDP_API_KEY_ID'),
  cdpApiKeySecret: required('CDP_API_KEY_SECRET'),
  cdpWalletSecret: required('CDP_WALLET_SECRET'),
  cdpWalletName: process.env.CDP_WALLET_NAME || 'payroll-bot',
  paymentNetwork: process.env.PAYMENT_NETWORK || 'base',
  agentId: process.env.AGENT_ID || 'payroll-bot',
};
