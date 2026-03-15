import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  encodeFunctionData,
  type Account,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, base, polygon, arbitrum, baseSepolia } from 'viem/chains';
import * as readline from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { enforceGuardrails, requiresApproval, promptForApproval, recordTransaction } from './guardrails.js';

// ── Network → chain + RPC mapping ──

interface NetworkConfig {
  chain: Chain;
  rpcs: string[];
}

const NETWORKS: Record<string, NetworkConfig> = {
  ethereum: {
    chain: mainnet,
    rpcs: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'],
  },
  base: {
    chain: base,
    rpcs: ['https://mainnet.base.org', 'https://base.llamarpc.com'],
  },
  polygon: {
    chain: polygon,
    rpcs: ['https://polygon-rpc.com', 'https://rpc.ankr.com/polygon'],
  },
  arbitrum: {
    chain: arbitrum,
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com'],
  },
  'base-sepolia': {
    chain: baseSepolia,
    rpcs: ['https://sepolia.base.org'],
  },
};

// USDC contract addresses per network
const USDC_ADDRESSES: Record<string, `0x${string}`> = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

const USDC_DECIMALS = 6;

// Minimal ERC-20 ABI for transfer + balanceOf
const ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ── Keystore path ──

const KEYSTORE_PATH = new URL('../keystore.json', import.meta.url).pathname;

// ── Unified wallet handle ──

export type WalletHandle =
  | { type: 'viem'; account: Account }
  | { type: 'cdp'; account: CdpAccount };

// CDP account type (from @coinbase/cdp-sdk)
type CdpAccount = Awaited<ReturnType<Awaited<ReturnType<typeof getCdpClient>>['evm']['getOrCreateAccount']>>;

// Lazy CDP client singleton
let _cdpClient: any = null;

async function getCdpClient() {
  if (!_cdpClient) {
    const { CdpClient } = await import('@coinbase/cdp-sdk');
    _cdpClient = new CdpClient({
      apiKeyId: config.cdpApiKeyId,
      apiKeySecret: config.cdpApiKeySecret,
      walletSecret: config.cdpWalletSecret,
    });
  }
  return _cdpClient;
}

// ── Pay options ──

export interface PayOptions {
  /** If true, run all guardrail checks but don't actually send the transaction. */
  dryRun?: boolean;
}

// ── Wallet loading ──

/**
 * Check whether payment is configured (CDP, keystore, or env var).
 */
export function isPaymentConfigured(): boolean {
  return !!config.cdpApiKeyId || existsSync(KEYSTORE_PATH) || !!config.walletPrivateKey;
}

/**
 * Load the wallet.
 * Priority:
 *   1. CDP wallet (if CDP_API_KEY_ID is set) — keys in secure enclaves
 *   2. Encrypted keystore (if keystore.json exists)
 *   3. WALLET_PRIVATE_KEY env var
 */
export async function loadWallet(): Promise<WalletHandle> {
  // 1. CDP wallet
  if (config.cdpApiKeyId) {
    console.log('  Loading CDP wallet (keys in Coinbase secure enclaves)...');
    const cdp = await getCdpClient();
    const account = await cdp.evm.getOrCreateAccount({ name: config.cdpWalletName });
    console.log(`  CDP wallet: ${account.address}`);
    return { type: 'cdp', account };
  }

  // 2. Keystore
  if (existsSync(KEYSTORE_PATH)) {
    const account = await loadKeystoreAccount();
    return { type: 'viem', account };
  }

  // 3. Env var
  if (config.walletPrivateKey) {
    const key = config.walletPrivateKey.startsWith('0x')
      ? config.walletPrivateKey as `0x${string}`
      : `0x${config.walletPrivateKey}` as `0x${string}`;
    return { type: 'viem', account: privateKeyToAccount(key) };
  }

  throw new Error('No wallet configured. Set CDP_API_KEY_ID, WALLET_PRIVATE_KEY, or run: npm run generate-keystore');
}

/**
 * Get the wallet address from a WalletHandle.
 */
export function getAddress(wallet: WalletHandle): string {
  return wallet.account.address;
}

/**
 * Get USDC balance for the wallet on the given network.
 */
export async function checkBalance(wallet: WalletHandle, network: string): Promise<string> {
  if (wallet.type === 'cdp') {
    return getUsdcBalanceCdp(wallet.account, network);
  }
  return getUsdcBalanceViem(wallet.account, network);
}

/**
 * Send USDC to a recipient with guardrails enforced.
 *
 * Guardrails are checked INSIDE this function — they cannot be bypassed:
 *   1. Per-transaction cap (hard block)
 *   2. Daily spend limit (rolling 24h)
 *   3. Recipient allowlist (fail-closed: empty = deny all)
 *   4. Operator approval for large amounts (with timeout + TTY detection)
 *
 * After successful payment, the transaction is recorded in the guardrails ledger.
 *
 * Use { dryRun: true } to validate all checks without sending the transaction.
 */
export async function pay(
  wallet: WalletHandle,
  toAddress: string,
  amount: number,
  network: string,
  options: PayOptions = {},
): Promise<string> {
  // ── Guardrails: enforced here, no opt-out ──

  // 1-3: Per-tx cap, daily limit, allowlist (throws if blocked)
  enforceGuardrails(amount, toAddress);

  // 4: Operator approval for large amounts
  if (requiresApproval(amount)) {
    const approved = await promptForApproval(amount, toAddress);
    if (!approved) {
      throw new Error('GUARDRAIL: Payment rejected — operator denied or approval timed out.');
    }
  }

  // Dry run: all checks passed, return without sending
  if (options.dryRun) {
    console.log(`  [DRY RUN] All guardrails passed. Would send $${amount} USDC to ${toAddress} on ${network}.`);
    return '0x' + '0'.repeat(64); // placeholder hash
  }

  // ── Execute payment ──

  let txHash: string;

  if (wallet.type === 'cdp') {
    txHash = await sendUsdcCdp(wallet.account, toAddress, amount, network);
  } else {
    txHash = await sendUsdcViem(wallet.account, toAddress, amount, network);
  }

  // ── Record in ledger ──
  recordTransaction(amount, toAddress, txHash);

  return txHash;
}

// ── Viem (keystore / private key) implementations ──

async function loadKeystoreAccount(): Promise<Account> {
  console.log('  Loading wallet from keystore.json...');
  const keystoreJson = await readFile(KEYSTORE_PATH, 'utf-8');
  const keystore = JSON.parse(keystoreJson);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question('  Enter keystore password: ');
  rl.close();

  const { Keystore } = await import('ox');
  const key = Keystore.toKey(keystore, { password });
  const privateKey = Keystore.decrypt(keystore, key) as `0x${string}`;
  return privateKeyToAccount(privateKey);
}

async function getUsdcBalanceViem(account: Account, network: string): Promise<string> {
  const net = NETWORKS[network];
  if (!net) throw new Error(`Unsupported network: ${network}`);

  const usdcAddress = USDC_ADDRESSES[network];
  if (!usdcAddress) throw new Error(`No USDC address for network: ${network}`);

  const client = createPublicClient({
    chain: net.chain,
    transport: http(net.rpcs[0]),
  });

  const balance = await client.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });

  return formatUnits(balance, USDC_DECIMALS);
}

async function sendUsdcViem(
  account: Account,
  toAddress: string,
  amount: number,
  network: string,
): Promise<string> {
  const net = NETWORKS[network];
  if (!net) throw new Error(`Unsupported network: ${network}`);

  const usdcAddress = USDC_ADDRESSES[network];
  if (!usdcAddress) throw new Error(`No USDC address for network: ${network}`);

  const amountWei = parseUnits(amount.toString(), USDC_DECIMALS);

  const walletClient = createWalletClient({
    account,
    chain: net.chain,
    transport: http(net.rpcs[0]),
  });

  const publicClient = createPublicClient({
    chain: net.chain,
    transport: http(net.rpcs[0]),
  });

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [toAddress as `0x${string}`, amountWei],
  });

  const txHash = await walletClient.sendTransaction({
    to: usdcAddress,
    data,
  });

  console.log(`  Tx sent: ${txHash}`);
  console.log('  Waiting for confirmation...');

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 2,
  });

  if (receipt.status !== 'success') {
    throw new Error(`Transaction reverted: ${txHash}`);
  }

  return txHash;
}

// ── CDP implementations ──

async function getUsdcBalanceCdp(account: CdpAccount, network: string): Promise<string> {
  const cdp = await getCdpClient();
  const result = await cdp.evm.listTokenBalances({
    address: account.address,
    network: network as 'base',
  });

  for (const b of result.balances) {
    if (b.token.symbol?.toUpperCase() === 'USDC') {
      return formatUnits(b.amount.amount, b.amount.decimals);
    }
  }

  return '0';
}

async function sendUsdcCdp(
  account: CdpAccount,
  toAddress: string,
  amountUsdc: number,
  network: string,
): Promise<string> {
  const result = await account.transfer({
    to: toAddress as `0x${string}`,
    amount: parseUnits(amountUsdc.toFixed(6), 6),
    token: 'usdc',
    network: network as 'base',
  });

  console.log(`  Tx sent: ${result.transactionHash}`);
  return result.transactionHash;
}

// ── Legacy exports (backwards compatibility) ──

export async function loadWalletAccount(): Promise<Account> {
  if (existsSync(KEYSTORE_PATH)) {
    return loadKeystoreAccount();
  }
  if (config.walletPrivateKey) {
    const key = config.walletPrivateKey.startsWith('0x')
      ? config.walletPrivateKey as `0x${string}`
      : `0x${config.walletPrivateKey}` as `0x${string}`;
    return privateKeyToAccount(key);
  }
  throw new Error('No wallet configured. Set WALLET_PRIVATE_KEY or run: npm run generate-keystore');
}

export async function getUsdcBalance(account: Account, network: string): Promise<string> {
  return getUsdcBalanceViem(account, network);
}

export async function sendUsdc(account: Account, toAddress: string, amount: number, network: string): Promise<string> {
  return sendUsdcViem(account, toAddress, amount, network);
}
