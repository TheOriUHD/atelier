/**
 * docs/PROMPTS.md §10: shipped and assembled prompt text uses none of the signature markers, and, when
 * ATELIER_PROMPT_CORPUS points at local copies of published prompts (never committed), shares no run of ten or more
 * words with them.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('keeps prompt text original', () => {
  const run = spawnSync(process.execPath, [join(import.meta.dirname, '../../scripts/check-prompt-originality.mjs')], { encoding: 'utf8', env: process.env });
  expect(run.stdout).toContain('Originality check passed.');
  expect(run.status).toBe(0);
}, 600_000);
