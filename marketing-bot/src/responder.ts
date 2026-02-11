import { config } from './config.js';
import { notify } from './notify.js';
import type { Message } from './types.js';

/**
 * Responder — generates replies to human messages.
 *
 * Two LLM modes + keyword fallback:
 *
 *   1. OpenAI-compatible API — set LLM_BASE_URL (+ LLM_API_KEY if needed)
 *   2. Anthropic native API — set LLM_BASE_URL=https://api.anthropic.com
 *   3. No LLM — keyword fallback, zero dependencies
 */

// ── Conversation history for LLM context ──

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const conversationHistory: ChatMessage[] = [];

// ── Public API ──

function isAnthropic(): boolean {
  return config.llmBaseUrl.includes('anthropic.com');
}

export async function generateReply(
  msg: Message,
  jobDescription: string,
): Promise<string> {
  if (!config.llmBaseUrl) return keywordFallback(msg, jobDescription);
  if (isAnthropic()) return callAnthropic(msg, jobDescription);
  return callOpenAICompat(msg, jobDescription);
}

export function getResponderName(): string {
  if (!config.llmBaseUrl) {
    return 'keyword fallback (set LLM_BASE_URL for smart replies)';
  }
  if (isAnthropic()) {
    return `Anthropic (${config.llmModel})`;
  }
  return `${config.llmModel} via ${config.llmBaseUrl}`;
}

// ── Shared ──

function getSystemPrompt(jobDescription: string): string {
  const projectName = config.projectName;
  const projectUrl = config.projectUrl;
  const socialLinks = config.socialLinks;

  let prompt = `You are a marketing agent that hires humans for social media promotion tasks. You are friendly, professional, and enthusiastic about the project.

Your current marketing task:
- Project: ${projectName}${projectUrl ? ` (${projectUrl})` : ''}
- Description: ${jobDescription}
- Payment: $${config.jobPriceUsdc} USDC on ${config.paymentNetwork}`;

  if (socialLinks) {
    prompt += `\n\nOfficial social accounts for mentions/tags:\n${socialLinks}`;
    prompt += `\nWhen posting, the marketer should tag/mention the appropriate account for each platform.`;
  }

  prompt += `

Answer the human's questions about this task honestly. Keep replies short (1-3 sentences). Don't repeat the full task description unless asked.

If the human seems ready, encourage them to click "Accept" in the dashboard.`;

  return config.llmSystemPrompt || prompt;
}

// ── OpenAI-compatible responder ──

async function callOpenAICompat(msg: Message, jobDescription: string): Promise<string> {
  conversationHistory.push({ role: 'user', content: msg.content });

  const systemPrompt = getSystemPrompt(jobDescription);

  const body = {
    model: config.llmModel,
    messages: [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
    ],
    max_tokens: 300,
    stream: false,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.llmApiKey) {
    headers['Authorization'] = `Bearer ${config.llmApiKey}`;
  }

  let url = config.llmBaseUrl;
  if (!url.includes('/chat/completions')) {
    url = url.replace(/\/+$/, '') + '/v1/chat/completions';
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      const errorMsg = `${res.status} ${err.slice(0, 200)}`;
      console.log(`  [LLM] Error: ${errorMsg}`);
      notify.llmError(config.llmBaseUrl, errorMsg);
      conversationHistory.pop();
      return keywordFallback(msg, jobDescription);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      conversationHistory.pop();
      return keywordFallback(msg, jobDescription);
    }

    conversationHistory.push({ role: 'assistant', content: reply });
    return reply;
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.log(`  [LLM] Connection error: ${errorMsg}`);
    notify.llmError(config.llmBaseUrl, errorMsg);
    conversationHistory.pop();
    return keywordFallback(msg, jobDescription);
  }
}

// ── Anthropic native API ──

async function callAnthropic(msg: Message, jobDescription: string): Promise<string> {
  conversationHistory.push({ role: 'user', content: msg.content });

  const systemPrompt = getSystemPrompt(jobDescription);

  const body = {
    model: config.llmModel,
    max_tokens: 300,
    system: systemPrompt,
    messages: conversationHistory,
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.llmApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
      const errorMsg = `${res.status} ${err.error?.message || res.statusText}`;
      console.log(`  [LLM] Anthropic error: ${errorMsg}`);
      notify.llmError('Anthropic', errorMsg);
      conversationHistory.pop();
      return keywordFallback(msg, jobDescription);
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
    };

    const reply = data.content?.[0]?.text || keywordFallback(msg, jobDescription);
    conversationHistory.push({ role: 'assistant', content: reply });
    return reply;
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.log(`  [LLM] Anthropic connection error: ${errorMsg}`);
    notify.llmError('Anthropic', errorMsg);
    conversationHistory.pop();
    return keywordFallback(msg, jobDescription);
  }
}

// ── Keyword fallback (marketing-focused) ──

function keywordFallback(msg: Message, jobDescription: string): string {
  const lower = msg.content.toLowerCase();
  const socialNote = config.socialLinks ? ` Our socials: ${config.socialLinks}` : '';

  if (lower.includes('tag') || lower.includes('mention') || (lower.includes('social') && lower.includes('account'))) {
    return config.socialLinks
      ? `When posting, please tag/mention our official accounts: ${config.socialLinks}`
      : 'When posting, please mention our project by name so we can track engagement!';
  }
  if (lower.includes('what') && (lower.includes('post') || lower.includes('content') || lower.includes('share'))) {
    return `We're looking for an authentic post about ${config.projectName}. Here are the details: ${jobDescription}`;
  }
  if (lower.includes('where') || lower.includes('platform') || lower.includes('which')) {
    return `Any major social platform works — whatever has your best audience!${socialNote}`;
  }
  if (lower.includes('when') || lower.includes('time') || lower.includes('deadline')) {
    return 'No hard deadline — anytime this week works. Just let me know when you post!';
  }
  if (lower.includes('price') || lower.includes('pay') || lower.includes('money') || lower.includes('rate') || lower.includes('usdc')) {
    return `The payment is $${config.jobPriceUsdc} USDC on ${config.paymentNetwork}, sent to your wallet as soon as you accept.`;
  }
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
    return `Hi ${msg.senderName}! Thanks for your interest in promoting ${config.projectName}. Feel free to ask any questions, or hit Accept when you're ready!`;
  }
  if (lower.includes('?')) {
    return `Good question! Here are the full details: ${jobDescription} — Payment is $${config.jobPriceUsdc} USDC on ${config.paymentNetwork}. Let me know if anything else is unclear.`;
  }

  return `Thanks for the message, ${msg.senderName}! The promotion details are in the job description. Accept when you're ready and I'll send payment right away.`;
}
