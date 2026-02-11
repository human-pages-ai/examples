import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from './config.js';
import { ask, confirm } from './prompt.js';

const ENV_PATH = path.resolve(process.cwd(), '.env');

/**
 * Check whether the project-specific config looks like it needs setup.
 * Returns true if PROJECT_NAME is still the default or PROJECT_URL is empty.
 */
export function needsSetup(): boolean {
  return config.projectName === 'our project' || !config.projectUrl;
}

/**
 * Interactive setup — prompts for project details and saves to .env.
 * Every field shows its current value; pressing Enter keeps it.
 */
export async function interactiveSetup(): Promise<void> {
  console.log('\n=== Project Setup ===');
  console.log('Configure the project you want marketers to promote.');
  console.log('Press Enter to keep the current value.\n');

  config.projectName = await askKeepCurrent(
    'Project name',
    config.projectName === 'our project' ? '' : config.projectName,
  ) || config.projectName;

  config.projectUrl = await askKeepCurrent(
    'Project URL',
    config.projectUrl,
  ) || config.projectUrl;

  // ── Social links ──
  if (config.socialLinks) {
    console.log(`\n  Social links: ${config.socialLinks}`);
    if (!await confirm('  Keep these?')) {
      config.socialLinks = await buildSocialLinks(config.socialLinks);
    }
  } else {
    if (await confirm('\n  Add social media links for marketers to tag?')) {
      config.socialLinks = await buildSocialLinks('');
    }
  }

  // ── Task description ──
  config.errandDescription = await askKeepCurrent(
    'Task description',
    config.errandDescription,
  ) || config.errandDescription;

  // ── Price ──
  const priceStr = await askKeepCurrent(
    'Payment per job (USDC)',
    String(config.jobPriceUsdc),
  );
  if (priceStr) config.jobPriceUsdc = parseFloat(priceStr);

  // ── Save ──
  console.log('\n--- Summary ---');
  console.log(`  Project:  ${config.projectName}`);
  console.log(`  URL:      ${config.projectUrl || '(none)'}`);
  console.log(`  Socials:  ${config.socialLinks || '(none)'}`);
  console.log(`  Task:     ${config.errandDescription}`);
  console.log(`  Price:    $${config.jobPriceUsdc} USDC`);

  if (await confirm('\nSave to .env?')) {
    saveToEnv({
      PROJECT_NAME: config.projectName,
      PROJECT_URL: config.projectUrl,
      SOCIAL_LINKS: config.socialLinks,
      ERRAND_DESCRIPTION: config.errandDescription,
      JOB_PRICE_USDC: String(config.jobPriceUsdc),
    });
    console.log('  Saved!\n');
  } else {
    console.log('  Changes kept in memory for this run only.\n');
  }
}

/**
 * Prompt for a value, showing current value in brackets.
 * Enter keeps current. Returns new value or empty string (meaning keep current).
 */
async function askKeepCurrent(label: string, current: string): Promise<string> {
  if (current) {
    const answer = await ask(`  ${label} [${current}]: `);
    return answer || '';
  }
  return await ask(`  ${label}: `);
}

/**
 * Build social links interactively, one platform at a time.
 */
async function buildSocialLinks(existing: string): Promise<string> {
  const platforms = ['X/Twitter', 'Instagram', 'Facebook', 'TikTok', 'Reddit', 'YouTube', 'Linktree'];

  // Parse existing links into a map
  const current = new Map<string, string>();
  if (existing) {
    for (const part of existing.split('|')) {
      const trimmed = part.trim();
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const val = trimmed.slice(colonIdx + 1).trim();
        current.set(key, val);
      }
    }
  }

  console.log('  Enter the URL for each platform (Enter to skip):');
  const links: string[] = [];

  for (const platform of platforms) {
    const prev = current.get(platform) || '';
    const hint = prev ? ` [${prev}]` : '';
    const url = await ask(`    ${platform}${hint}: `);
    const value = url || prev;
    if (value) links.push(`${platform}: ${value}`);
  }

  const custom = await ask('    Other (e.g. "Discord: https://discord.gg/xyz"): ');
  if (custom) links.push(custom);

  return links.join(' | ');
}

/**
 * Write key=value pairs into the .env file.
 * Updates existing keys in-place; appends new ones.
 */
function saveToEnv(values: Record<string, string>): void {
  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  } catch {
    // No .env yet — we'll create one
  }

  const remaining = new Set(Object.keys(values));

  // Update existing lines
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([A-Z_]+)=/);
    if (match && match[1] in values) {
      const key = match[1];
      lines[i] = `${key}=${quoteEnvValue(values[key])}`;
      remaining.delete(key);
    }
  }

  // Append any keys not already in the file
  if (remaining.size > 0) {
    if (lines[lines.length - 1] !== '') lines.push('');
    for (const key of remaining) {
      lines.push(`${key}=${quoteEnvValue(values[key])}`);
    }
  }

  fs.writeFileSync(ENV_PATH, lines.join('\n'));
}

/** Wrap value in double quotes if it contains spaces, pipes, or special characters. */
function quoteEnvValue(value: string): string {
  if (!value) return '';
  if (/[\s|#"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}
