/**
 * Nothing added by default (docs/PROMPTS.md §9.1, §10.3): no shipped template, tool description or note, and no
 * assembled prompt with safeguards off, uses content-policy vocabulary. The optional safeguards block is the one
 * place for it. Exceptions are listed with a reason in neutrality.allow.txt.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assemble, CASES } from './__fixtures__/prompt-cases.ts';

const WORDS = [
  'harm',
  'harmful',
  'refuse',
  'refused',
  'refuses',
  'refusal',
  'decline',
  'declined',
  'declines',
  'inappropriate',
  'appropriate',
  'unsafe',
  'safety',
  'safeguard',
  'safeguards',
  'content settings',
  'sensitive',
  'illegal',
  'dangerous',
  'minor',
  'minors',
  'nsfw',
  'sexual',
  'hate',
  'extremism',
  'extremist',
  'self-harm',
  'suicide',
  'ethical',
  'moral',
  'uncensored',
  'no restrictions',
  'no longer apply',
];
const PATTERN = new RegExp(`(?<![\\w-])(${WORDS.map((w) => w.replace(/[-\\s]/g, (c) => (c === '-' ? '\\-' : '\\s+'))).join('|')})(?![\\w-])`, 'gi');
/** Files whose job is the optional block itself. */
const EXEMPT = /^(safeguards\.|notes\/safeguards-changed\.md$)/;

async function allowed(): Promise<{ source: string; phrase: string }[]> {
  const text = await readFile(join(import.meta.dirname, 'neutrality.allow.txt'), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const [source, phrase] = l.split(' | ');
      return { source: source!.trim(), phrase: phrase!.trim() };
    });
}

/** Policy words in `text`, minus the allowed phrases for `source`. */
async function hits(source: string, text: string): Promise<string[]> {
  const allow = (await allowed()).filter((a) => a.source === source || a.source === '*');
  const cleaned = allow.reduce((t, a) => t.replaceAll(a.phrase, ''), text);
  return [...cleaned.matchAll(PATTERN)].map((m) => `${source}: "${cleaned.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, ' ')}"`);
}

describe('neutrality', () => {
  it('holds for every shipped template outside the safeguards block', async () => {
    const dir = join(import.meta.dirname, '../../prompts');
    const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.md') && !EXEMPT.test(f));
    const found: string[] = [];
    for (const f of files) found.push(...(await hits(f, await readFile(join(dir, f), 'utf8'))));
    expect(found).toEqual([]);
  });

  it('holds for what models receive with safeguards off: prompts, tools and notes', async () => {
    const found: string[] = [];
    for (const [name, c] of Object.entries(CASES)) {
      if (name.startsWith('safeguards.')) continue;
      const a = await assemble(c);
      found.push(...(await hits(name, [...a.system.map((b) => b.text), ...a.notes, JSON.stringify(a.tools)].join('\n'))));
    }
    expect(found).toEqual([]);
  });
});
