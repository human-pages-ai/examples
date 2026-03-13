/**
 * Pay for an existing job.
 * Handles the full flow: approve work (if submitted) -> send USDC -> record payment.
 *
 * Usage: npx tsx src/pay-now.ts <jobId>
 */
import { config } from './config.js';
import { getWallet, getUsdcBalance, sendUsdc } from './wallet.js';
import { getHumanProfile, getJobStatus, approveCompletion, markJobPaid } from './api.js';

const JOB_ID = process.argv[2];
if (!JOB_ID) { console.error('Usage: npx tsx src/pay-now.ts <jobId>'); process.exit(1); }

async function main() {
  // 1. Check job status
  let job = await getJobStatus(JOB_ID) as any;
  console.log(`  Job ${JOB_ID}: ${job.status}`);
  console.log(`  Amount: $${job.priceUsdc} USDC`);

  const amount = parseFloat(job.priceUsdc);

  // 2. Approve work if submitted
  if (job.status === 'SUBMITTED') {
    console.log('  Approving submitted work...');
    const approved = await approveCompletion(JOB_ID);
    console.log(`  -> ${approved.status}`);
    job = approved;
  }

  // 3. Validate status allows payment
  const payableStatuses = ['ACCEPTED', 'COMPLETED', 'IN_PROGRESS'];
  if (!payableStatuses.includes(job.status)) {
    console.error(`  Cannot pay a job with status: ${job.status}`);
    process.exit(1);
  }

  // 4. Get recipient wallet
  const profile = await getHumanProfile(job.humanId);
  const wallet = profile.wallets?.find((w) => w.network === config.paymentNetwork);
  if (!wallet) { console.error(`  ${profile.name} has no ${config.paymentNetwork} wallet.`); process.exit(1); }
  console.log(`  Recipient: ${profile.name} (${wallet.address})`);

  // 5. Load wallet & check balance
  const account = await getWallet();
  const balance = await getUsdcBalance(account);
  console.log(`  Bot wallet: ${account.address} (${balance} USDC)`);
  if (parseFloat(balance) < amount) {
    console.error(`  Insufficient balance.`);
    process.exit(1);
  }

  // 6. Send USDC
  console.log(`  Sending $${amount} USDC...`);
  const txHash = await sendUsdc(account, wallet.address, amount);
  console.log(`  Tx: ${txHash}`);

  // 7. Record on platform
  const paid = await markJobPaid(JOB_ID, {
    paymentTxHash: txHash,
    paymentNetwork: config.paymentNetwork,
    paymentToken: 'USDC',
    paymentAmount: amount,
  });
  console.log(`  Status: ${(paid as any).status}`);
  console.log(`\n  Done! https://basescan.org/tx/${txHash}`);
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
