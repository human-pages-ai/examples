import { config } from './config.js';
import { searchHumans, createListing, getListings, getListingApplications, makeListingOffer } from './api.js';
import { startWebhookServer } from './webhook.js';
import { runBot, resumeBot } from './bot.js';
import { needsSetup, interactiveSetup } from './setup.js';
import { choose, ask, confirm, closePrompt } from './prompt.js';
import type { Human } from './types.js';

/** Score a human for marketing fitness (higher = better). */
function marketingScore(h: Human): number {
  let score = 0;

  // Skills — marketing-relevant keywords
  const marketingKeywords = [
    'marketing', 'social media', 'content', 'promotion', 'advertising',
    'copywriting', 'seo', 'influencer', 'branding', 'video', 'tiktok',
    'instagram', 'twitter', 'youtube', 'community',
  ];
  const skillsLower = h.skills.map((s) => s.toLowerCase());
  for (const kw of marketingKeywords) {
    if (skillsLower.some((s) => s.includes(kw))) score += 10;
  }

  // Reputation — completed jobs and rating
  score += Math.min(h.reputation.jobsCompleted * 3, 30);
  if (h.reputation.avgRating != null) {
    score += h.reputation.avgRating * 5; // max 25
  }

  // Rate — prefer humans within budget
  if (h.minRateUsdc != null) {
    if (h.minRateUsdc <= config.jobPriceUsdc) {
      score += 15;
    } else {
      score -= 10;
    }
  }

  return score;
}

/**
 * Interactive listing creation — "can't find any pros? post a listing and let them come to you."
 */
async function postListingFlow(): Promise<void> {
  console.log('\n=== Post a Listing ===');
  console.log("Can't find the right pro? Post a listing and let them come to you.\n");

  const title = await ask('  Listing title: ');
  if (!title) { console.log('Aborted.'); return; }

  const description = await ask('  Description (what the human should do): ') || config.errandDescription;

  const budgetStr = await ask(`  Budget in USDC [${config.jobPriceUsdc}]: `);
  const budgetUsdc = budgetStr ? parseFloat(budgetStr) : config.jobPriceUsdc;
  if (budgetUsdc < 5) { console.log('Minimum budget is $5 USDC.'); return; }

  const skillsRaw = await ask('  Required skills (comma-separated, or Enter to skip): ');
  const requiredSkills = skillsRaw ? skillsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const category = await ask('  Category (e.g. social-media, photography, research — or Enter to skip): ');

  const location = await ask('  Location (city/region, or Enter for remote): ');
  const workMode = location ? 'ONSITE' : 'REMOTE';

  const daysStr = await ask('  Expires in how many days? [14]: ');
  const expiresInDays = daysStr ? parseInt(daysStr, 10) : 14;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

  const maxStr = await ask('  Max applicants [10]: ');
  const maxApplicants = maxStr ? parseInt(maxStr, 10) : 10;

  console.log('\n--- Listing Preview ---');
  console.log(`  Title:       ${title}`);
  console.log(`  Description: ${description}`);
  console.log(`  Budget:      $${budgetUsdc} USDC`);
  console.log(`  Skills:      ${requiredSkills.length > 0 ? requiredSkills.join(', ') : '(any)'}`);
  console.log(`  Category:    ${category || '(none)'}`);
  console.log(`  Location:    ${location || 'Remote'}`);
  console.log(`  Expires:     ${expiresInDays} days`);
  console.log(`  Max apps:    ${maxApplicants}`);

  if (!await confirm('\nPost this listing?')) {
    console.log('Aborted.');
    return;
  }

  console.log('\nPosting listing...');
  const callbackUrl = config.webhookUrl ? `${config.webhookUrl}/webhook` : undefined;

  const result = await createListing({
    title,
    description,
    budgetUsdc,
    requiredSkills,
    category: category || undefined,
    location: location || undefined,
    workMode,
    expiresAt,
    maxApplicants,
    ...(callbackUrl && {
      callbackUrl,
      callbackSecret: config.webhookSecret,
    }),
  });

  console.log(`  Listing posted! ID: ${result.id}`);
  console.log(`  Status: ${result.status}`);
  if (result.rateLimit) {
    console.log(`  Rate limit: ${result.rateLimit.remaining} listings remaining (${result.rateLimit.tier} tier)`);
  }
  console.log(`\n  View on the job board: ${config.apiUrl.replace('/api', '')}/listings/${result.id}`);
  console.log(`  To check applications: npm run dev -- --applications ${result.id}\n`);
}

/**
 * Check applications on a listing and optionally make offers.
 */
async function checkApplicationsFlow(listingId: string): Promise<void> {
  console.log(`\n=== Applications for listing ${listingId} ===\n`);

  const apps = await getListingApplications(listingId);

  if (apps.length === 0) {
    console.log('No applications yet. Check back later!\n');
    return;
  }

  console.log(`${apps.length} application(s):\n`);

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    const rating = app.human.reputation?.avgRating != null ? `${app.human.reputation.avgRating}★` : 'no reviews';
    const jobs = app.human.reputation?.jobsCompleted ?? 0;
    const skills = app.human.skills.length > 0 ? app.human.skills.join(', ') : 'none';
    console.log(`  ${i + 1}. ${app.human.name} [${app.status}]`);
    console.log(`     Skills: ${skills} | ${rating} | ${jobs} jobs`);
    console.log(`     Pitch: "${app.pitch}"`);
    console.log(`     Applied: ${new Date(app.createdAt).toLocaleString()}\n`);
  }

  const pending = apps.filter((a) => a.status === 'PENDING');
  if (pending.length === 0) {
    console.log('No pending applications to act on.\n');
    return;
  }

  if (await confirm('Make an offer to one of the pending applicants?')) {
    const idx = await choose(
      pending,
      (app) => `${app.human.name} — "${app.pitch.slice(0, 60)}${app.pitch.length > 60 ? '...' : ''}"`,
      '\nSelect applicant # ',
    );

    const chosen = pending[idx];
    console.log(`\nMaking offer to ${chosen.human.name}...`);
    console.log('  (This creates a binding job. The human will accept or reject.)');

    if (await confirm('  Confirm offer?')) {
      const result = await makeListingOffer(listingId, chosen.id);
      console.log(`  Offer sent! Job ID: ${result.jobId}`);
      console.log(`  To manage this job: npm run dev -- --resume ${result.jobId}\n`);
    } else {
      console.log('  Cancelled.\n');
    }
  }
}

/**
 * Show current listings posted by this agent.
 */
async function showListingsFlow(): Promise<void> {
  console.log('\n=== My Listings ===\n');
  const data = await getListings();

  if (data.listings.length === 0) {
    console.log("No listings yet. Post one with: npm run dev -- --post-listing\n");
    return;
  }

  for (const l of data.listings) {
    const apps = l._count?.applications ?? 0;
    console.log(`  [${l.status}] $${l.budgetUsdc} — ${l.title}`);
    console.log(`     ${apps} application(s) | Expires: ${new Date(l.expiresAt).toLocaleDateString()}`);
    console.log(`     ID: ${l.id}\n`);
  }

  console.log(`Total: ${data.pagination.total} listing(s)\n`);
}

async function main() {
  const args = process.argv.slice(2);

  // --setup  →  force interactive config
  const forceSetup = args.includes('--setup');

  // --resume <jobId>  →  pick up an existing job
  const resumeIdx = args.indexOf('--resume');
  const resumeJobId = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined;

  // --post-listing  →  create a job board listing
  const isPostListing = args.includes('--post-listing');

  // --listings  →  show current listings
  const isShowListings = args.includes('--listings');

  // --applications <listingId>  →  check applications
  const appsIdx = args.indexOf('--applications');
  const appsListingId = appsIdx !== -1 ? args[appsIdx + 1] : undefined;

  if (resumeIdx !== -1 && !resumeJobId) {
    console.error('Usage: npm run dev -- --resume <jobId>');
    process.exit(1);
  }

  if (appsIdx !== -1 && !appsListingId) {
    console.error('Usage: npm run dev -- --applications <listingId>');
    process.exit(1);
  }

  // Interactive setup if forced or if project config looks unconfigured
  if (forceSetup || needsSetup()) {
    if (!forceSetup) {
      console.log('Project not configured yet (PROJECT_NAME / PROJECT_URL missing).');
    }
    await interactiveSetup();
  }

  // Start the webhook server only if a public URL is configured
  if (config.webhookUrl) {
    await startWebhookServer();
  } else {
    console.log('No WEBHOOK_URL configured — using polling mode');
  }

  try {
    if (isPostListing) {
      await postListingFlow();
    } else if (isShowListings) {
      await showListingsFlow();
    } else if (appsListingId) {
      await checkApplicationsFlow(appsListingId);
    } else if (resumeJobId) {
      await resumeBot(resumeJobId);
    } else {
      // Accept an optional humanId arg for non-interactive / scripted use
      let humanId = args.find((a) => !a.startsWith('--') && a !== resumeJobId);

      if (!humanId) {
        // ── Interactive human selection ──
        console.log('Searching for available humans...\n');
        const humans = await searchHumans();

        if (humans.length === 0) {
          console.log("No available humans found. Can't find the right pro?");
          console.log('Post a listing and let them come to you:\n');
          console.log('  npm run dev -- --post-listing\n');
          process.exit(0);
        }

        // Sort by marketing fitness, best first
        const scored = humans
          .map((h) => ({ human: h, score: marketingScore(h) }))
          .sort((a, b) => b.score - a.score);
        const sorted = scored.map((s) => s.human);
        const topScore = scored[0].score;

        const idx = await choose(
          sorted,
          (h, i) => {
            const rating = h.reputation?.avgRating != null ? `${h.reputation.avgRating}★` : 'no reviews';
            const jobs = h.reputation?.jobsCompleted ?? 0;
            const loc = h.location ?? 'unknown location';
            const skills = h.skills.length > 0 ? h.skills.join(', ') : 'none listed';
            const rate = h.minRateUsdc ? `$${h.minRateUsdc}+` : 'negotiable';
            const tag = (i === 0 && topScore > 0) ? ' ← recommended' : '';
            return `${h.name}${h.username ? ` (@${h.username})` : ''} — ${loc}${tag}\n     Skills: ${skills}\n     ${rate} | ${rating} | ${jobs} jobs`;
          },
          '\nWho would you like to hire? (Enter for #1) # ',
        );

        humanId = sorted[idx].id;
        console.log(`\nSelected: ${sorted[idx].name} (${humanId})\n`);
      }

      await runBot(humanId);
    }
  } catch (err) {
    console.error('Bot error:', (err as Error).message);
    process.exit(1);
  } finally {
    closePrompt();
  }
}

main();
