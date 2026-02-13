import { x402Client } from '@x402/core/client';
import { x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner, type ClientEvmSigner } from '@x402/evm';
import { loadWalletAccount, isPaymentConfigured } from './pay.js';

let _httpClient: x402HTTPClient | null = null;

/**
 * Lazily create and cache an x402 HTTP client for signing pay-per-use requests.
 * Returns null if no wallet is configured.
 */
export async function getX402Client(): Promise<x402HTTPClient | null> {
  if (_httpClient) return _httpClient;

  if (!isPaymentConfigured()) return null;

  // loadWalletAccount() always returns a PrivateKeyAccount (has signTypedData)
  // but is typed as the generic Account — cast to satisfy ClientEvmSigner
  const account = await loadWalletAccount() as unknown as ClientEvmSigner;
  const signer = toClientEvmSigner(account);

  const client = new x402Client();
  registerExactEvmScheme(client, { signer });

  _httpClient = new x402HTTPClient(client);
  return _httpClient;
}
