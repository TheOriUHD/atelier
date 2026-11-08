/** What the person sent before, per folder (`history.jsonl`): ↑/↓ in the message box go through it. */
import { appendFile, readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const LIMIT = 500;

export async function readHistory(file: string, folder: string): Promise<string[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const out: string[] = [];
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line) as { folder?: string; text?: string };
      if (entry.folder === folder && typeof entry.text === 'string') out.push(entry.text);
    } catch {
      // A torn line.
    }
  }
  return out.slice(-LIMIT);
}

export async function appendHistory(file: string, folder: string, text: string): Promise<void> {
  if (!text.trim()) return;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify({ folder, text, at: Date.now() })}\n`, { mode: 0o600 });
}
