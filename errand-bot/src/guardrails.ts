import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { config } from './config.js';

// ── Payment Guardrails ──
// Enforced in code, not just documented. Every payment goes through these checks.

export interface GuardrailConfig {
  maxPerTransaction: number;
  maxDailySpend: number;
  allowedRecipients: Set<string>;
  requireApprovalAbove: number;
}

interface LedgerEntry {
  timestamp: string;
  amount: number;
  recipient: string;
  txHash: string;
}

interface LedgerFile {
  entries: LedgerEntry[];
}

const LEDGER_PATH = new URL('../.guardrails-ledger.json', import.meta.url).pathname;

const guardrailConfig: GuardrailConfig = {
  maxPerTransaction: config.maxPerTransaction,
  maxDailySpend: config.maxDailySpend,
  allowedRecipients: new Set<string>(),
  requireApprovalAbove: config.requireApprovalAbove,
};

// ── Ledger helpers ──

function loadLedger(): LedgerFile {
  if (!existsSync(LEDGER_PATH)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, 'utf-8')) as LedgerFile;
  } catch {
    return { entries: [] };
  }
}

function saveLedger(ledger: LedgerFile): void {
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf-8');
}

// ── Public API ──

/**
 * Add a recipient address to the allowlist.
 * Only addresses fetched from the Human Pages API should be added.
 */
export function addAllowedRecipient(address: string): void {
  guardrailConfig.allowedRecipients.add(address.toLowerCase());
}

/**
 * Get total USDC spent in the current 24-hour window.
 */
export function getDailySpend(): number {
  const ledger = loadLedger();
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;

  return ledger.entries
    .filter((e) => new Date(e.timestamp).getTime() > twentyFourHoursAgo)
    .reduce((sum, e) => sum + e.amount, 0);
}

/**
 * Check whether a transaction is allowed. Throws with a clear reason if blocked.
 */
export function checkTransaction(amount: number, recipientAddress: string): void {
  // Hard cap per transaction
  if (amount > guardrailConfig.maxPerTransaction) {
    throw new Error(
      `GUARDRAIL: Payment of $${amount} exceeds max per-transaction limit of $${guardrailConfig.maxPerTransaction}. ` +
      `Adjust MAX_PER_TRANSACTION if this is intentional.`,
    );
  }

  // Daily spend limit
  const dailySoFar = getDailySpend();
  if (dailySoFar + amount > guardrailConfig.maxDailySpend) {
    throw new Error(
      `GUARDRAIL: Payment of $${amount} would push daily spend to $${dailySoFar + amount}, ` +
      `exceeding the $${guardrailConfig.maxDailySpend} daily limit. ` +
      `Already spent $${dailySoFar} in the last 24 hours.`,
    );
  }

  // Allowlisted recipients only
  if (guardrailConfig.allowedRecipients.size > 0 && !guardrailConfig.allowedRecipients.has(recipientAddress.toLowerCase())) {
    throw new Error(
      `GUARDRAIL: Recipient ${recipientAddress} is not in the allowlist. ` +
      `Only addresses fetched from the Human Pages API are allowed.`,
    );
  }
}

/**
 * Returns true if the amount exceeds the approval threshold.
 */
export function requiresApproval(amount: number): boolean {
  return amount > guardrailConfig.requireApprovalAbove;
}

/**
 * Prompt the operator on stdin for approval. Returns true if approved.
 */
export async function promptForApproval(amount: number, recipient: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n  GUARDRAIL: Payment of $${amount} USDC to ${recipient} exceeds $${guardrailConfig.requireApprovalAbove} approval threshold.\n` +
      `  Approve this payment? (yes/no): `,
    );
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Record a completed transaction in the ledger.
 */
export function recordTransaction(amount: number, recipientAddress: string, txHash: string): void {
  const ledger = loadLedger();
  ledger.entries.push({
    timestamp: new Date().toISOString(),
    amount,
    recipient: recipientAddress,
    txHash,
  });
  saveLedger(ledger);
  console.log(`  Guardrail ledger: recorded $${amount} to ${recipientAddress} (daily total: $${getDailySpend()})`);
}
