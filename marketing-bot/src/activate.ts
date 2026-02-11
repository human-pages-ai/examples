import { config } from './config.js';
import { getActivationStatus, verifySocialActivation } from './api.js';

async function main() {
  const postUrl = process.argv[2];

  if (!config.agentApiKey) {
    console.error('Error: AGENT_API_KEY must be set in .env');
    process.exit(1);
  }

  if (!postUrl) {
    // No URL provided — just show current status
    console.log('Checking activation status...');
    const status = await getActivationStatus();
    console.log(`  Status: ${status.status}`);
    console.log(`  Tier: ${status.tier ?? 'none'}`);
    if (status.status === 'ACTIVE') {
      console.log('\n  ✅ Agent is active! You can run the bot now.');
    } else {
      console.log('\n  Usage: npx tsx src/activate.ts <post_url>');
      console.log('  Provide the URL of your social media post containing the activation code.');
    }
    return;
  }

  console.log(`Verifying social post: ${postUrl}`);
  try {
    const result = await verifySocialActivation(postUrl);
    console.log(`\n  ✅ Agent activated!`);
    console.log(`  Status: ${result.status}`);
    console.log(`  Tier: ${result.tier}`);
    console.log('\n  You can now run the bot:');
    console.log('    npx tsx src/index.ts <humanId>');
  } catch (err) {
    console.error(`\n  ❌ Verification failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
