import { config } from './config.js';
import { searchHumans } from './api.js';
import { startWebhookServer } from './webhook.js';
import { runBot } from './bot.js';

async function main() {
  const humanId = process.argv[2];

  if (!humanId) {
    // No human ID provided — search and show available humans
    console.log('Searching for available humans...\n');
    const humans = await searchHumans();

    if (humans.length === 0) {
      console.log('No available humans found.');
      process.exit(0);
    }

    for (const h of humans) {
      const rating = h.reputation?.avgRating != null ? `${h.reputation.avgRating}★` : 'no reviews';
      const jobs = h.reputation?.jobsCompleted ?? 0;
      console.log(`  ${h.name}${h.username ? ` (@${h.username})` : ''}`);
      console.log(`    ID: ${h.id}`);
      console.log(`    Location: ${h.location ?? 'not specified'}`);
      console.log(`    Skills: ${h.skills.length > 0 ? h.skills.join(', ') : 'none listed'}`);
      console.log(`    Rate: ${h.minRateUsdc ? `$${h.minRateUsdc}+` : 'negotiable'} | ${rating} | ${jobs} jobs`);
      console.log('');
    }

    console.log(`Found ${humans.length} human(s). Run with a human ID:\n`);
    console.log(`  npx tsx src/index.ts <humanId>\n`);
    process.exit(0);
  }

  // Start the webhook server only if a public URL is configured
  if (config.webhookUrl) {
    await startWebhookServer();
  } else {
    console.log('No WEBHOOK_URL configured — using polling mode');
  }

  try {
    await runBot(humanId);
  } catch (err) {
    console.error('Bot error:', (err as Error).message);
    process.exit(1);
  }
}

main();
