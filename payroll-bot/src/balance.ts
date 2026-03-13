/**
 * Check the bot's CDP wallet address and USDC balance.
 *
 * Usage: npm run balance
 */

import { config } from './config.js';
import { getWallet, getUsdcBalance } from './wallet.js';

async function main() {
  console.log('\n  Payroll Bot — Wallet Info');
  console.log('  ─────────────────────────');

  const account = await getWallet();
  console.log(`  Address:  ${account.address}`);
  console.log(`  Network:  ${config.paymentNetwork}`);

  const balance = await getUsdcBalance(account);
  console.log(`  USDC:     ${balance}`);

  console.log(`\n  Fund this address with USDC on ${config.paymentNetwork} to enable payments.\n`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
