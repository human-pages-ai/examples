import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import {
  registerAgent,
  getHuman,
  getHumanProfile,
  getActivationStatus,
  requestActivationCode,
  getJob,
  createJob,
  sendMessage,
  getMessages,
  markJobPaid,
  reviewJob,
} from './api.js';
import { waitForEventWithMessages } from './webhook.js';
import { generateReply, getResponderName } from './responder.js';
import { notify, isOwnerNotifyConfigured } from './notify.js';
import { isPaymentConfigured, loadWalletAccount, getUsdcBalance, sendUsdc } from './pay.js';
import { ask, confirm } from './prompt.js';
import type { Message } from './types.js';

// 24 hours — effectively unlimited; operator can Ctrl+C anytime
const WAIT_TIMEOUT_MS = 86_400_000;

/**
 * Shared message handler used by both wait-for-accept and wait-for-complete.
 */
function makeMessageHandler(jobId: string, knownIds: Set<string>) {
  return async (msg: Message) => {
    console.log(`  [${msg.senderName}]: ${msg.content}`);
    notify.humanMessage(jobId, msg.senderName, msg.content);
    const reply = await generateReply(msg, config.errandDescription);
    try {
      const sent = await sendMessage(jobId, reply);
      knownIds.add(sent.id);
      console.log(`  [Bot]: ${reply}`);
    } catch (err) {
      console.log(`  [Bot] Failed to reply: ${(err as Error).message}`);
    }
  };
}

/**
 * Run the job lifecycle from the appropriate phase based on current status.
 *
 * Statuses: PENDING → ACCEPTED → PAID → COMPLETED
 * The bot picks up wherever the job currently is.
 */
async function runJobLifecycle(
  jobId: string,
  humanId: string,
  humanName: string,
  jobStatus: string,
  knownIds: Set<string>,
): Promise<void> {
  const onMessage = makeMessageHandler(jobId, knownIds);

  // ── Phase: Wait for acceptance ──
  if (jobStatus === 'PENDING' || jobStatus === 'OFFERED') {
    console.log('\nWaiting for human to accept the marketing task...');
    console.log('  (The human will receive an email/Telegram notification)');
    console.log('  (Bot will reply to messages while waiting)');

    const accepted = await waitForEventWithMessages(
      jobId,
      'job.accepted',
      knownIds,
      onMessage,
      WAIT_TIMEOUT_MS,
    );

    const acceptedName = accepted.data.humanName ?? accepted.data.humanId;
    console.log(`  Task accepted by ${acceptedName}!`);
    notify.jobAccepted(jobId, acceptedName);

    if (accepted.data.contact) {
      const c = accepted.data.contact;
      console.log('  Contact info (for coordination):');
      if (c.email) console.log(`    Email: ${c.email}`);
      if (c.telegram) console.log(`    Telegram: ${c.telegram}`);
      if (c.whatsapp) console.log(`    WhatsApp: ${c.whatsapp}`);
      if (c.signal) console.log(`    Signal: ${c.signal}`);
    } else {
      try {
        const fullProfile = await getHumanProfile(humanId);
        const c = { email: fullProfile.contactEmail, telegram: fullProfile.telegram, whatsapp: fullProfile.whatsapp, signal: fullProfile.signal };
        const contactParts = [c.email, c.telegram, c.whatsapp, c.signal].filter(Boolean);
        if (contactParts.length > 0) {
          console.log(`  Contact info: ${contactParts.join(' | ')}`);
        }
      } catch {
        // Contact info is optional, don't block the flow
      }
    }

    // Send coordination message
    console.log('\nSending promotion details...');
    try {
      let coordBody = 'Awesome, thanks for accepting! Here\'s a reminder of what to do:\n\n'
        + `${config.errandDescription}\n`;
      if (config.socialLinks) {
        coordBody += `\nOur socials: ${config.socialLinks}\n`;
      }
      coordBody += `\nPayment: $${config.jobPriceUsdc} USDC on ${config.paymentNetwork}.\n\n`
        + 'Once you\'re done, share the links to your posts here and mark the job as complete. '
        + 'I\'ll send payment right away!';
      const coordMsg = await sendMessage(jobId, coordBody);
      knownIds.add(coordMsg.id);
      console.log('  [Bot]: Sent promotion details.');
    } catch (err) {
      console.log(`  Could not send message: ${(err as Error).message}`);
    }

    jobStatus = 'ACCEPTED';
  }

  // ── Phase: Pay ──
  if (jobStatus === 'ACCEPTED') {
    console.log('\nPayment...');

    if (isPaymentConfigured()) {
      try {
        const account = await loadWalletAccount();
        console.log(`  Wallet loaded: ${account.address}`);

        const network = config.paymentNetwork;
        const balance = await getUsdcBalance(account, network);
        console.log(`  USDC balance on ${network}: ${balance}`);

        if (parseFloat(balance) < config.jobPriceUsdc) {
          throw new Error(
            `Insufficient USDC balance: ${balance} < ${config.jobPriceUsdc}. `
            + `Fund your wallet on ${network}.`,
          );
        }

        let recipientAddress = await resolveRecipientWallet(humanId, humanName, network);

        if (!recipientAddress) {
          console.log('  No wallet address — skipping on-chain payment.');
        } else {
          console.log(`\n  Ready to send $${config.jobPriceUsdc} USDC → ${recipientAddress} on ${network}`);

          if (!await confirm('  Confirm payment?')) {
            console.log('  Payment skipped by operator.');
          } else {
            console.log(`  Sending...`);
            const txHash = await sendUsdc(account, recipientAddress, config.jobPriceUsdc, network);
            console.log(`  Confirmed: ${txHash}`);

            const paid = await markJobPaid(jobId, {
              paymentTxHash: txHash,
              paymentNetwork: network,
              paymentToken: 'USDC',
              paymentAmount: config.jobPriceUsdc,
            });
            console.log(`  Payment recorded on platform: ${paid.status}`);
          }
        }
      } catch (err) {
        console.log(`  Payment failed: ${(err as Error).message}`);
      }
    } else {
      console.log('  No wallet configured.');
      console.log('  To enable real payments:');
      console.log('    npm run generate-keystore   (recommended)');
      console.log('    or set WALLET_PRIVATE_KEY    (testing only)');
    }

    jobStatus = 'PAID';
  }

  // ── Phase: Wait for completion ──
  if (jobStatus === 'PAID') {
    console.log('\nWaiting for human to complete the promotion...');
    console.log('  (The human can message you while working)');

    const completed = await waitForEventWithMessages(
      jobId,
      'job.completed',
      knownIds,
      onMessage,
      WAIT_TIMEOUT_MS,
    );

    console.log(`  Promotion completed! (status: ${completed.status})`);
    notify.jobCompleted(jobId, humanName);

    jobStatus = 'COMPLETED';
  }

  // ── Phase: Review ──
  if (jobStatus === 'COMPLETED') {
    console.log('\nLeaving a review...');
    const rating = await ask('  Rating (1-5, default 5): ');
    const ratingNum = rating ? parseInt(rating, 10) : 5;
    const comment = await ask('  Comment (or Enter for default): ');

    const review = await reviewJob(jobId, {
      rating: ratingNum,
      comment: comment || 'Great social media promotion — posted on time with quality content. Would hire again!',
    });
    console.log(`  Review submitted (rating: ${review.rating}/5)`);
  }

  console.log('\n=== Marketing task complete ===\n');
}

/**
 * Resume an existing job by ID.
 * Fetches the job, loads existing messages, and picks up from the current status.
 */
export async function resumeBot(jobId: string): Promise<void> {
  console.log('\n=== Marketing Bot — Resuming ===');
  console.log(`Job: ${jobId}`);
  console.log(`Responder: ${getResponderName()}`);
  console.log(`Payment network: ${config.paymentNetwork}`);
  console.log(`Owner notifications: ${isOwnerNotifyConfigured() ? 'Telegram' : 'off'}\n`);

  // Fetch the job to see where we left off
  console.log('Fetching job status...');
  const job = await getJob(jobId);
  console.log(`  Status: ${job.status}`);
  console.log(`  Title: ${job.title}`);
  console.log(`  Human: ${job.human?.name ?? job.humanId}`);

  if (job.status === 'REJECTED') {
    console.log('\n  This job was rejected by the human. Nothing to resume.');
    return;
  }

  if (job.status === 'REVIEWED') {
    console.log('\n  This job is already reviewed. Nothing to resume.');
    return;
  }

  // Load existing messages so we don't re-process them
  const knownIds = new Set<string>();
  try {
    const existingMsgs = await getMessages(jobId);
    for (const msg of existingMsgs) {
      knownIds.add(msg.id);
    }
    console.log(`  Loaded ${knownIds.size} existing messages`);
  } catch {
    console.log('  Could not load existing messages — starting fresh');
  }

  // Fetch human info
  const humanName = job.human?.name ?? 'Unknown';
  const humanId = job.humanId;

  console.log(`\nResuming from status: ${job.status}`);

  await runJobLifecycle(jobId, humanId, humanName, job.status, knownIds);
}

/**
 * Main bot lifecycle — hires a human for a social media marketing task.
 * Interactive: asks the operator for guidance at every decision point.
 */
export async function runBot(humanId: string): Promise<void> {
  console.log('\n=== Marketing Bot ===');
  console.log('Hiring humans for social media promotion via Human Pages');
  console.log(`Responder: ${getResponderName()}`);
  console.log(`Payment network: ${config.paymentNetwork}`);
  console.log(`Owner notifications: ${isOwnerNotifyConfigured() ? 'Telegram' : 'off'}\n`);

  // ── Step 1: Register (if needed) ──
  let agentId: string;

  if (config.agentApiKey) {
    console.log('Step 1: Using existing API key (skipping registration)');
    agentId = 'self';
  } else {
    console.log('Step 1: Registering as a new agent...');
    const reg = await registerAgent();
    config.agentApiKey = reg.apiKey;
    agentId = reg.agent.id;
    console.log(`  Registered as "${reg.agent.name}" (id: ${agentId})`);
    console.log(`  API key: ${reg.apiKey}`);

    // Persist the key to .env so the user doesn't have to do it manually
    const envPath = path.resolve(import.meta.dirname, '..', '.env');
    const envContents = fs.readFileSync(envPath, 'utf-8');
    fs.writeFileSync(envPath, envContents.replace(/^AGENT_API_KEY=.*$/m, `AGENT_API_KEY=${reg.apiKey}`));
    console.log('  API key saved to .env');
  }

  // ── Step 2: Check activation status ──
  console.log('\nStep 2: Checking agent activation status...');
  try {
    const activation = await getActivationStatus();
    const jobsInfo = activation.jobLimit != null ? ` | Jobs today: ${activation.jobsToday ?? 0}/${activation.jobLimit}` : '';
    console.log(`  Status: ${activation.status} | Tier: ${activation.tier ?? 'none'}${jobsInfo}`);

    if (activation.status !== 'ACTIVE') {
      console.error(`\n  Agent is ${activation.status}. You must activate before creating jobs.\n`);

      try {
        const activationCode = await requestActivationCode();
        console.error(`  Activation code: ${activationCode.code}`);
        console.error(`  Expires: ${activationCode.expiresAt}\n`);
        if (activationCode.requirements) {
          console.error(`  Requirements: ${activationCode.requirements}\n`);
        }

        const suggestedPosts = activationCode.suggestedPosts || {};
        const platforms = activationCode.platforms || [];
        if (platforms.length > 0) {
          console.error('  Copy-paste for each platform:\n');
          for (const platform of platforms) {
            console.error(`    ${platform}:`);
            console.error(`      ${suggestedPosts[platform] || activationCode.code}\n`);
          }
        }

        console.error('  After posting, run:');
        console.error(`    npx tsx src/activate.ts <post_url>\n`);
      } catch (err) {
        console.error(`  Could not get activation code: ${(err as Error).message}`);
        console.error(`  Activate your agent at ${config.apiUrl}, then re-run the bot.\n`);
      }
      return;
    }
  } catch (err) {
    console.log(`  Could not check activation status: ${(err as Error).message}`);
    console.log('  Continuing — the API will reject requests if agent is not active.');
  }

  // ── Step 3: Fetch the target human ──
  console.log(`\nStep 3: Fetching human ${humanId}...`);
  const candidate = await getHuman(humanId);
  console.log(`  ${candidate.name} (@${candidate.username}) in ${candidate.location ?? 'unknown'}`);
  console.log(`  Skills: ${candidate.skills.length > 0 ? candidate.skills.join(', ') : 'none listed'}`);
  console.log(`  ${candidate.reputation.jobsCompleted} jobs, rating: ${candidate.reputation.avgRating ?? 'n/a'}`);

  // ── Confirm task details with the operator ──
  console.log(`\nTask: ${config.errandDescription}`);
  console.log(`Price: $${config.jobPriceUsdc} USDC on ${config.paymentNetwork}`);

  if (!await confirm('\nSend this offer?')) {
    // Let the operator adjust on the fly
    const desc = await ask('New task description (or Enter to keep): ');
    if (desc) config.errandDescription = desc;

    const price = await ask(`New price in USDC (or Enter to keep $${config.jobPriceUsdc}): `);
    if (price) config.jobPriceUsdc = parseFloat(price);

    console.log(`\nUpdated → Task: ${config.errandDescription}`);
    console.log(`Updated → Price: $${config.jobPriceUsdc} USDC`);

    if (!await confirm('Send this offer?')) {
      console.log('Aborted.');
      return;
    }
  }

  // ── Step 4: Create marketing job offer ──
  console.log('\nStep 4: Sending marketing job offer...');

  const callbackUrl = config.webhookUrl ? `${config.webhookUrl}/webhook` : undefined;

  const job = await createJob({
    humanId: candidate.id,
    agentId,
    title: 'Social media promotion — share & post',
    description: config.errandDescription,
    priceUsdc: config.jobPriceUsdc,
    ...(callbackUrl && {
      callbackUrl,
      callbackSecret: config.webhookSecret,
    }),
  });

  console.log(`  Job created: ${job.id} (status: ${job.status})`);
  console.log(`  Price: $${config.jobPriceUsdc} USDC`);
  console.log(`  To resume this job later: npm run dev -- --resume ${job.id}`);
  notify.jobCreated(job.id, candidate.name, config.jobPriceUsdc);

  // ── Step 5: Send an intro message ──
  console.log('\nStep 5: Sending intro message...');
  const knownIds = new Set<string>();
  try {
    let introBody = `Hi ${candidate.name}! We're hiring marketers to promote ${config.projectName}.`
      + `${config.projectUrl ? ` (${config.projectUrl})` : ''}\n\n`
      + `${config.errandDescription}\n`;
    if (config.socialLinks) {
      introBody += `\nOur official accounts to tag/mention:\n${formatSocialLinks(config.socialLinks)}\n`;
    }
    introBody += `\nPayment: $${config.jobPriceUsdc} USDC on ${config.paymentNetwork}.\n`
      + `Let me know if you have any questions before accepting!`;
    const intro = await sendMessage(job.id, introBody);
    knownIds.add(intro.id);
    console.log(`  Message sent (id: ${intro.id})`);
  } catch (err) {
    console.log(`  Could not send message: ${(err as Error).message}`);
  }

  // Hand off to the shared lifecycle
  await runJobLifecycle(job.id, candidate.id, candidate.name, 'PENDING', knownIds);
}

/**
 * Resolve the recipient's wallet address for a given network.
 *
 * 1. Tries the human's HumanPages profile.
 * 2. If not found, asks the operator what to do.
 *
 * Returns the address, or undefined if the operator chooses to skip.
 */
async function resolveRecipientWallet(
  humanId: string,
  humanName: string,
  network: string,
): Promise<string | undefined> {
  // Try profile first
  try {
    const profile = await getHumanProfile(humanId);
    const wallet = profile.wallets?.find((w) => w.network === network);
    if (wallet) {
      console.log(`  ${humanName}'s wallet on ${network}: ${wallet.address}`);
      return wallet.address;
    }

    // Show what wallets they do have
    if (profile.wallets && profile.wallets.length > 0) {
      console.log(`  ${humanName} has wallets on: ${profile.wallets.map((w) => `${w.network} (${w.address})`).join(', ')}`);
    } else {
      console.log(`  ${humanName} has no wallets on their profile.`);
    }
  } catch (err) {
    console.log(`  Could not fetch profile: ${(err as Error).message}`);
  }

  console.log(`  No ${network} wallet found on their profile.`);
  const addr = await ask(`  Paste ${humanName}'s ${network} wallet address (or Enter to skip): `);

  if (!addr) return undefined;

  // Basic address validation
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    console.log('  That doesn\'t look like a valid address.');
    if (!await confirm('  Use it anyway?')) return undefined;
  }

  return addr;
}

/**
 * Format pipe-separated social links into a bulleted list.
 * Input:  "X/Twitter: https://x.com/Foo | Instagram: https://instagram.com/Foo"
 * Output: "• X/Twitter: https://x.com/Foo\n• Instagram: https://instagram.com/Foo"
 */
function formatSocialLinks(links: string): string {
  return links
    .split('|')
    .map((s) => `• ${s.trim()}`)
    .join('\n');
}
