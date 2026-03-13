import { CdpClient } from '@coinbase/cdp-sdk';
import { parseUnits, formatUnits } from 'viem';
import { config } from './config.js';

let _cdp: CdpClient | null = null;

function getCdp(): CdpClient {
  if (!_cdp) {
    _cdp = new CdpClient({
      apiKeyId: config.cdpApiKeyId,
      apiKeySecret: config.cdpApiKeySecret,
      walletSecret: config.cdpWalletSecret,
    });
  }
  return _cdp;
}

/**
 * Get or create the bot's persistent wallet.
 * Same name -> same address every time. Keys live in Coinbase's secure enclaves.
 */
export async function getWallet() {
  const cdp = getCdp();
  return cdp.evm.getOrCreateAccount({ name: config.cdpWalletName });
}

/**
 * Get USDC balance for the bot's wallet.
 */
export async function getUsdcBalance(account: Awaited<ReturnType<typeof getWallet>>): Promise<string> {
  const cdp = getCdp();
  const result = await cdp.evm.listTokenBalances({
    address: account.address,
    network: config.paymentNetwork as 'base',
  });

  for (const b of result.balances) {
    if (b.token.symbol?.toUpperCase() === 'USDC') {
      return formatUnits(b.amount.amount, b.amount.decimals);
    }
  }

  return '0';
}

/**
 * Send USDC to a recipient. Fully autonomous -- no prompts.
 * Returns the transaction hash.
 */
export async function sendUsdc(
  account: Awaited<ReturnType<typeof getWallet>>,
  toAddress: string,
  amountUsdc: number,
): Promise<string> {
  const result = await account.transfer({
    to: toAddress as `0x${string}`,
    amount: parseUnits(amountUsdc.toFixed(6), 6),
    token: 'usdc',
    network: config.paymentNetwork as 'base',
  });

  return result.transactionHash;
}
