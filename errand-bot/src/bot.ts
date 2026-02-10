import { config } from './config.js';
import {
  registerAgent,
  getHuman,
  getHumanProfile,
  getActivationStatus,
  requestActivationCode,
  createJob,
  sendMessage,
  getMessages,
  markJobPaid,
  reviewJob,
} from './api.js';
import { waitForEvent, waitForEventWithMessages } from './webhook.js';
import { generateReply, getResponderName } from './responder.js';
import { notify, isOwnerNotifyConfigured } from './notify.js';
import { isPaymentConfigured, loadWalletAccount, getUsdcBalance, sendUsdc } from './pay.js';

/**
 * Main bot lifecycle — demonstrates how an AI agent hires a real human
 * for a physical-world task it cannot do on its own:
 *
 *   Register → Activate check → Fetch human → Offer → Message → Wait → Pay → Wait → Review
 */
export async function runBot(humanId: string): Promise<void> {
  console.log('\n=== Local Errand Bot ===');
  console.log('Bridging AI to the physical world via Human Pages');
  console.log(`Responder: ${getResponderName()}`);
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
    console.log('  ⚠️  Save this key to AGENT_API_KEY in your .env — it cannot be retrieved later!');
  }

  // ── Step 2: Check activation status ──
  console.log('\nStep 2: Checking agent activation status...');
  try {
    const activation = await getActivationStatus();
    const jobsInfo = activation.jobLimit != null ? ` | Jobs today: ${activation.jobsToday ?? 0}/${activation.jobLimit}` : '';
    console.log(`  Status: ${activation.status} | Tier: ${activation.tier ?? 'none'}${jobsInfo}`);

    if (activation.status !== 'ACTIVE') {
      console.error(`\n  ❌ Agent is ${activation.status}. You must activate before creating jobs.\n`);

      // Request activation code and display the API's per-platform instructions
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
        console.error('  Activate your agent at humanpages.ai, then re-run the bot.\n');
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
  console.log(`  ${candidate.reputation.jobsCompleted} jobs, rating: ${candidate.reputation.avgRating ?? 'n/a'}`);

  // ── Step 4: Create job offer ──
  console.log('\nStep 4: Sending errand job offer...');

  const callbackUrl = config.webhookUrl ? `${config.webhookUrl}/webhook` : undefined;

  const job = await createJob({
    humanId: candidate.id,
    agentId,
    title: 'Local errand — pickup & delivery',
    description: config.errandDescription,
    priceUsdc: config.jobPriceUsdc,
    ...(callbackUrl && {
      callbackUrl,
      callbackSecret: config.webhookSecret,
    }),
  });

  console.log(`  Job created: ${job.id} (status: ${job.status})`);
  console.log(`  Price: $${config.jobPriceUsdc} USDC`);
  notify.jobCreated(job.id, candidate.name, config.jobPriceUsdc);

  // ── Step 5: Send an intro message ──
  console.log('\nStep 5: Sending intro message...');
  const knownIds = new Set<string>();
  try {
    const intro = await sendMessage(
      job.id,
      `Hi ${candidate.name}! I'm an AI agent looking for help with a local errand. `
      + `The task: ${config.errandDescription} `
      + `Let me know if you have any questions before accepting!`,
    );
    knownIds.add(intro.id);
    console.log(`  Message sent (id: ${intro.id})`);
  } catch (err) {
    console.log(`  Could not send message: ${(err as Error).message}`);
  }

  // ── Step 6: Wait for acceptance (while responding to messages) ──
  console.log('\nStep 6: Waiting for human to accept the errand...');
  console.log('  (The human will receive an email/Telegram notification)');
  console.log('  (Bot will reply to messages while waiting)');

  const accepted = await waitForEventWithMessages(
    job.id,
    'job.accepted',
    knownIds,
    async (msg) => {
      console.log(`  [${msg.senderName}]: ${msg.content}`);
      notify.humanMessage(job.id, msg.senderName, msg.content);
      const reply = await generateReply(msg, config.errandDescription);
      try {
        const sent = await sendMessage(job.id, reply);
        knownIds.add(sent.id);
        console.log(`  [Bot]: ${reply}`);
      } catch (err) {
        console.log(`  [Bot] Failed to reply: ${(err as Error).message}`);
      }
    },
    600_000,
  );

  console.log(`  Errand accepted by ${accepted.data.humanName ?? accepted.data.humanId}!`);
  notify.jobAccepted(job.id, accepted.data.humanName ?? accepted.data.humanId);

  if (accepted.data.contact) {
    const c = accepted.data.contact;
    console.log('  Contact info (for coordination):');
    if (c.email) console.log(`    Email: ${c.email}`);
    if (c.telegram) console.log(`    Telegram: ${c.telegram}`);
    if (c.whatsapp) console.log(`    WhatsApp: ${c.whatsapp}`);
    if (c.signal) console.log(`    Signal: ${c.signal}`);
  } else {
    // Webhook/polling mode may not include contact — fetch via gated profile
    console.log('  Contact info not in acceptance payload, fetching full profile...');
    try {
      const fullProfile = await getHumanProfile(candidate.id);
      const c = { email: fullProfile.contactEmail, telegram: fullProfile.telegram, whatsapp: fullProfile.whatsapp, signal: fullProfile.signal };
      const contactParts = [c.email, c.telegram, c.whatsapp, c.signal].filter(Boolean);
      if (contactParts.length > 0) {
        console.log(`  Contact info: ${contactParts.join(' | ')}`);
      } else {
        console.log('  No contact info available on profile.');
      }
    } catch (err) {
      console.log(`  Could not fetch full profile: ${(err as Error).message}`);
    }
  }

  // ── Step 7: Send coordination message ──
  console.log('\nStep 7: Sending coordination details...');
  try {
    const coordMsg = await sendMessage(
      job.id,
      'Great, you accepted! Here are the details:\n'
      + `Task: ${config.errandDescription}\n`
      + 'I\'ll record the payment now so you can get started.',
    );
    knownIds.add(coordMsg.id);
    console.log('  [Bot]: Sent coordination details.');
  } catch (err) {
    console.log(`  Could not send message: ${(err as Error).message}`);
  }

  // ── Step 8: Record payment ──
  console.log('\nStep 8: Recording payment...');

  if (isPaymentConfigured()) {
    // Real on-chain USDC payment
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

      // Fetch full profile (gated endpoint) for wallet addresses
      const human = await getHumanProfile(candidate.id);
      const wallet = human.wallets?.find((w) => w.network === network);
      if (!wallet) {
        throw new Error(
          `Human has no wallet on ${network}. `
          + `Ask them to add a ${network} wallet on their profile.`,
        );
      }

      console.log(`  Sending $${config.jobPriceUsdc} USDC to ${wallet.address} on ${network}...`);
      const txHash = await sendUsdc(account, wallet.address, config.jobPriceUsdc, network);
      console.log(`  Confirmed: ${txHash}`);

      const paid = await markJobPaid(job.id, {
        paymentTxHash: txHash,
        paymentNetwork: network,
        paymentToken: 'USDC',
        paymentAmount: config.jobPriceUsdc,
      });
      console.log(`  Payment recorded: ${paid.status}`);
    } catch (err) {
      console.log(`  Payment failed: ${(err as Error).message}`);
      console.log('  Continuing to demonstrate remaining steps...');
    }
  } else {
    // Demo mode — no wallet configured
    console.log('  [DEMO MODE] No wallet configured — using placeholder tx hash.');
    console.log('  To enable real payments, set WALLET_PRIVATE_KEY or run: npm run generate-keystore');
    const demoTxHash = '0x' + '0'.repeat(64);

    try {
      const paid = await markJobPaid(job.id, {
        paymentTxHash: demoTxHash,
        paymentNetwork: 'ethereum',
        paymentToken: 'USDC',
        paymentAmount: config.jobPriceUsdc,
      });
      console.log(`  Payment recorded: ${paid.status}`);
    } catch (err) {
      console.log(`  Payment recording failed (expected with demo tx): ${(err as Error).message}`);
      console.log('  Continuing to demonstrate remaining steps...');
    }
  }

  // ── Step 9: Wait for completion (while responding to messages) ──
  console.log('\nStep 9: Waiting for human to complete the errand...');
  console.log('  (The human can message you while working)');

  try {
    const completed = await waitForEventWithMessages(
      job.id,
      'job.completed',
      knownIds,
      async (msg) => {
        console.log(`  [${msg.senderName}]: ${msg.content}`);
        notify.humanMessage(job.id, msg.senderName, msg.content);
        const reply = await generateReply(msg, config.errandDescription);
        try {
          const sent = await sendMessage(job.id, reply);
          knownIds.add(sent.id);
          console.log(`  [Bot]: ${reply}`);
        } catch (err) {
          console.log(`  [Bot] Failed to reply: ${(err as Error).message}`);
        }
      },
      600_000,
    );

    console.log(`  Errand completed! (status: ${completed.status})`);
    notify.jobCompleted(job.id, accepted.data.humanName ?? accepted.data.humanId);

    // ── Step 10: Leave a review ──
    console.log('\nStep 10: Leaving a review...');
    const review = await reviewJob(job.id, {
      rating: 5,
      comment: 'Package delivered on time, great communication. Would hire again!',
    });
    console.log(`  Review submitted (rating: ${review.rating}/5)`);
  } catch (err) {
    console.log(`  ${(err as Error).message}`);
    console.log('  (Expected if payment was not recorded on-chain)');
  }

  console.log('\n=== Errand complete ===\n');
}
