import * as readline from 'node:readline/promises';

let rl: readline.Interface | null = null;

function getRL(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

/** Free the readline interface (call once at shutdown). */
export function closePrompt(): void {
  rl?.close();
  rl = null;
}

/** Ask a free-text question and return the trimmed answer. */
export async function ask(question: string): Promise<string> {
  const answer = await getRL().question(question);
  return answer.trim();
}

/** Ask for a yes/no confirmation (default: yes). */
export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} [Y/n] `);
  return answer === '' || answer.toLowerCase().startsWith('y');
}

/**
 * Present a numbered list and let the user pick one.
 * Returns the index of the chosen item (0-based).
 */
export async function choose<T>(
  items: T[],
  label: (item: T, index: number) => string,
  prompt = 'Choose: ',
): Promise<number> {
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}. ${label(items[i], i)}`);
  }
  while (true) {
    const raw = await ask(prompt);
    if (raw === '') return 0; // default to first item
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= items.length) return n - 1;
    console.log(`  Enter a number between 1 and ${items.length}, or press Enter for #1.`);
  }
}
