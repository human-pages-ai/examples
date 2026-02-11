import { config } from './config.js';
import { searchHumans } from './api.js';
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

async function main() {
  const args = process.argv.slice(2);

  // --setup  →  force interactive config
  const forceSetup = args.includes('--setup');

  // --resume <jobId>  →  pick up an existing job
  const resumeIdx = args.indexOf('--resume');
  const resumeJobId = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined;

  if (resumeIdx !== -1 && !resumeJobId) {
    console.error('Usage: npm run dev -- --resume <jobId>');
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
    if (resumeJobId) {
      await resumeBot(resumeJobId);
    } else {
      // Accept an optional humanId arg for non-interactive / scripted use
      let humanId = args.find((a) => !a.startsWith('--') && a !== resumeJobId);

      if (!humanId) {
        // ── Interactive human selection ──
        console.log('Searching for available humans...\n');
        const humans = await searchHumans();

        if (humans.length === 0) {
          console.log('No available humans found.');
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
