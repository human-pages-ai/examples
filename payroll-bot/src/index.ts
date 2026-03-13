/**
 * Payroll Bot — fully autonomous human payments via CDP agentic wallets.
 *
 * Usage:
 *   npm run pay -- --human <humanId> --amount <usdc> --title "..." --description "..."
 *
 * Flow:
 *   1. Load CDP wallet & verify balance
 *   2. Look up the human's wallet from their profile
 *   3. Create a job offer (upon_completion)
 *   4. Wait for the human to accept
 *   5. Wait for the human to submit work
 *   6. Approve the work
 *   7. Send USDC on Base
 *   8. Record the payment on the platform
 */

import { config } from './config.js';
import { getWallet, getUsdcBalance, sendUsdc } from './wallet.js';
import { getHumanProfile, createJob, getJobStatus, approveCompletion, markJobPaid } from './api.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const humanId = get('--human');
  const amount = get('--amount');
  const title = get('--title');
  const description = get('--description');

  if (!humanId || !amount) {
    console.error('Usage: npm run pay -- --human <humanId> --amount <usdc> --title "..." --description "..."');
    process.exit(1);
  }

  return {
    humanId,
    amount: parseFloat(amount),
    title: title || 'Payment',
    description: description || 'Payment for completed work.',
  };
}

const POLL_INTERVAL_MS = 15_000;
const MAX_POLL_TIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function waitForStatus(
  jobId: string,
  targetStatuses: string[],
  failStatuses: string[],
  label: string,
): Promise<string> {
  const start = Date.now();

  while (Date.now() - start < MAX_POLL_TIME_MS) {
    const job = await getJobStatus(jobId) as any;

    if (targetStatuses.includes(job.status)) return job.status;
    if (failStatuses.includes(job.status)) {
      throw new Error(`Job ${job.status} while waiting for ${label}.`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    process.stdout.write('.');
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

async function main() {
  const { humanId, amount, title, description } = parseArgs();

  console.log(`\n  Payroll Bot — $${amount} USDC`);
  console.log('  ─────────────────────────────────');

  // 1. Load wallet
  console.log('\n  [1/8] Loading CDP wallet...');
  const account = await getWallet();
  console.log(`        Address: ${account.address}`);

  // 2. Check balance
  console.log('\n  [2/8] Checking USDC balance...');
  const balance = await getUsdcBalance(account);
  console.log(`        Balance: ${balance} USDC`);
  if (parseFloat(balance) < amount) {
    console.error(`        Insufficient balance (${balance} < ${amount}). Fund the wallet first.`);
    process.exit(1);
  }

  // 3. Resolve recipient wallet
  console.log('\n  [3/8] Looking up recipient...');
  const profile = await getHumanProfile(humanId);
  const wallet = profile.wallets?.find((w) => w.network === config.paymentNetwork);
  if (!wallet) {
    console.error(`        ${profile.name} has no ${config.paymentNetwork} wallet on their profile.`);
    process.exit(1);
  }
  console.log(`        Recipient: ${profile.name} (${wallet.address})`);

  // 4. Create job offer
  console.log('\n  [4/8] Creating job offer...');
  const job = await createJob({
    humanId,
    title,
    description,
    priceUsdc: amount,
    paymentTiming: 'upon_completion',
  });
  console.log(`        Job: ${job.id}`);

  // 5. Wait for acceptance
  console.log(`\n  [5/8] Waiting for ${profile.name} to accept...`);
  process.stdout.write('        ');
  await waitForStatus(job.id, ['ACCEPTED', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETED'], ['REJECTED', 'CANCELLED', 'EXPIRED'], 'acceptance');
  console.log('\n        Accepted!');

  // 6. Wait for submission
  console.log(`\n  [6/8] Waiting for work submission...`);
  process.stdout.write('        ');
  const status = await waitForStatus(job.id, ['SUBMITTED', 'COMPLETED'], ['CANCELLED', 'EXPIRED'], 'submission');
  console.log('\n        Work submitted!');

  // 7. Approve work
  if (status === 'SUBMITTED') {
    console.log('\n  [7/8] Approving work...');
    await approveCompletion(job.id);
    console.log('        Approved!');
  } else {
    console.log('\n  [7/8] Already completed, skipping approval.');
  }

  // 8. Send USDC & record
  console.log('\n  [8/8] Sending USDC...');
  const txHash = await sendUsdc(account, wallet.address, amount);
  console.log(`        Tx: ${txHash}`);

  const paid = await markJobPaid(job.id, {
    paymentTxHash: txHash,
    paymentNetwork: config.paymentNetwork,
    paymentToken: 'USDC',
    paymentAmount: amount,
  });
  console.log(`        Status: ${(paid as any).status}`);

  console.log('\n  ─────────────────────────────────');
  console.log(`  Done! Paid $${amount} USDC to ${profile.name}`);
  console.log(`  Tx: https://basescan.org/tx/${txHash}\n`);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
