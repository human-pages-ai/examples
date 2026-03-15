import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { config } from './config.js';

// ── Payment Guardrails ──
// Enforced inside pay() — every payment goes through these checks.
// Cannot be bypassed by calling pay() directly.
// Your wallet balance is the real spending cap — only fund what you're willing to spend.

export interface GuardrailConfig {
  maxPerTransaction: number;
  maxDailySpend: number;
  allowedRecipients: Set<string>;
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

// ── Audit log entry types ──

type AuditDecision = 'ALLOWED' | 'BLOCKED' | 'DRY_RUN' | 'RECORDED';

interface AuditEntry {
  timestamp: string;
  decision: AuditDecision;
  rule: string;
  amount: number;
  recipient: string;
  details: string;
}

const LEDGER_PATH = new URL('../.guardrails-ledger.json', import.meta.url).pathname;
const AUDIT_LOG_PATH = new URL('../.guardrails-audit.jsonl', import.meta.url).pathname;

const guardrailConfig: GuardrailConfig = {
  maxPerTransaction: config.maxPerTransaction,
  maxDailySpend: config.maxDailySpend,
  allowedRecipients: new Set<string>(),
};

// ── Structured audit logging ──

function audit(decision: AuditDecision, rule: string, amount: number, recipient: string, details: string): void {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    decision,
    rule,
    amount,
    recipient,
    details,
  };

  // Append to JSONL file (one JSON object per line)
  try {
    appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Audit log failure should not block payments
  }

  // Console output with decision prefix
  const symbol = decision === 'ALLOWED' || decision === 'RECORDED' ? '+' : '-';
  console.log(`  [AUDIT ${symbol}${decision}] ${rule}: $${amount} → ${recipient.slice(0, 10)}... — ${details}`);
}

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
 * Must be called before pay() — empty allowlist = deny all.
 */
export function addAllowedRecipient(address: string): void {
  guardrailConfig.allowedRecipients.add(address.toLowerCase());
  audit('ALLOWED', 'allowlist-add', 0, address, 'Address added to allowlist');
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
 * Run all guardrail checks for a payment. Throws with a clear reason if blocked.
 * Called automatically by pay() — callers do not need to call this separately.
 */
export function enforceGuardrails(amount: number, recipientAddress: string): void {
  // 0. Reject invalid amounts
  if (amount <= 0) {
    audit('BLOCKED', 'invalid-amount', amount, recipientAddress, 'Amount must be greater than zero');
    throw new Error(`GUARDRAIL: Invalid payment amount: $${amount}. Must be greater than zero.`);
  }

  // 1. Hard cap per transaction
  if (amount > guardrailConfig.maxPerTransaction) {
    audit('BLOCKED', 'per-tx-cap', amount, recipientAddress,
      `$${amount} exceeds $${guardrailConfig.maxPerTransaction} limit`);
    throw new Error(
      `GUARDRAIL: Payment of $${amount} exceeds max per-transaction limit of $${guardrailConfig.maxPerTransaction}. ` +
      `Adjust MAX_PER_TRANSACTION if this is intentional.`,
    );
  }

  // 2. Daily spend limit
  const dailySoFar = getDailySpend();
  if (dailySoFar + amount > guardrailConfig.maxDailySpend) {
    audit('BLOCKED', 'daily-limit', amount, recipientAddress,
      `Would push daily to $${dailySoFar + amount}, limit is $${guardrailConfig.maxDailySpend}`);
    throw new Error(
      `GUARDRAIL: Payment of $${amount} would push daily spend to $${dailySoFar + amount}, ` +
      `exceeding the $${guardrailConfig.maxDailySpend} daily limit. ` +
      `Already spent $${dailySoFar} in the last 24 hours.`,
    );
  }

  // 3. Allowlist: fail-closed — empty allowlist = deny all
  if (!guardrailConfig.allowedRecipients.has(recipientAddress.toLowerCase())) {
    const reason = guardrailConfig.allowedRecipients.size === 0
      ? 'Allowlist is empty — call addAllowedRecipient() with an address from the Human Pages API first'
      : 'Address not in allowlist. Only addresses fetched from the Human Pages API are allowed';
    audit('BLOCKED', 'allowlist', amount, recipientAddress, reason);
    throw new Error(`GUARDRAIL: Recipient ${recipientAddress} blocked. ${reason}.`);
  }

  audit('ALLOWED', 'all-checks', amount, recipientAddress,
    `Per-tx OK ($${amount}/$${guardrailConfig.maxPerTransaction}), daily OK ($${dailySoFar + amount}/$${guardrailConfig.maxDailySpend}), allowlist OK`);
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
  audit('RECORDED', 'ledger', amount, recipientAddress,
    `tx=${txHash.slice(0, 14)}... daily_total=$${getDailySpend()}`);
}
