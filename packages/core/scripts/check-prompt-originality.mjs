// Originality check for prompt text (docs/PROMPTS.md §10). Compares the shipped templates, the assembled prompts in
// src/prompts/__snapshots__/prompts and docs/PROMPTS.md with a local corpus of published prompts that is
// never committed, and greps them for a committed list of short signature markers.
//
//   ATELIER_PROMPT_CORPUS=/path/a:/path/b node scripts/check-prompt-originality.mjs [--min 10] [--warn 8]
//
// A run of `--min` (10) or more consecutive words shared with the corpus fails; runs of `--warn` (8) or more are
// listed for review. Without a corpus only the markers are checked. Exit code 1 on any failure.
import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = fileURLToPath(new URL('.', import.meta.url));
const core = join(here, '..');
const repo = join(core, '../..');
const { values } = parseArgs({ options: { min: { type: 'string', default: '10' }, warn: { type: 'string', default: '8' } } });
const MIN = Number(values.min);
const WARN = Math.min(Number(values.warn), MIN);
const CORPUS_EXT = /\.(md|txt|json|js|mjs|cjs|ts|py|ya?ml|j2)$/;
const WORD = /[a-z0-9_]+(?:'[a-z]+)?/g;

const words = (text) => text.toLowerCase().match(WORD) ?? [];

async function files(dir, pattern) {
  const out = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && pattern.test(entry.name)) out.push(join(entry.parentPath, entry.name));
  }
  return out.sort();
}

const candidates = [
  ...(await files(join(core, 'prompts'), /\.md$/)),
  ...(await files(join(core, 'src/prompts/__snapshots__/prompts'), /\.txt$/)),
  join(repo, 'docs/PROMPTS.md'),
];
/**
 * In an assembled prompt, tool schemas count by their descriptions: schema keywords and parameter names are fixed by
 * JSON Schema and by compatibility. That covers the tools JSON and the schemas a prompted-tools prompt spells out.
 */
function prose(text) {
  const descriptions = (json) => {
    const out = [];
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k === 'description' && typeof x === 'string') out.push(x);
          else walk(x);
        }
      }
    };
    walk(JSON.parse(json));
    return out.join('\n\n');
  };
  const inline = text.replace(/^Arguments JSON Schema: (.*)$/gm, (_m, json) => descriptions(json));
  const at = inline.search(/^# Tools: /m);
  return at < 0 ? inline : `${inline.slice(0, at)}\n\n${descriptions(inline.slice(inline.indexOf('\n', at) + 1))}`;
}

const texts = new Map();
for (const path of candidates) {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text !== null) texts.set(path, path.endsWith('.txt') ? prose(text) : text);
}

let failed = false;

// Signature markers: short phrases, matched case-insensitively with whitespace normalized.
const markers = (await readFile(join(here, 'prompt-signature-phrases.txt'), 'utf8'))
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
for (const [path, text] of texts) {
  const flat = text.toLowerCase().replace(/\s+/g, ' ');
  for (const marker of markers) {
    if (flat.includes(marker.toLowerCase())) {
      console.log(`FAIL ${relative(repo, path)}: signature marker "${marker}"`);
      failed = true;
    }
  }
}

// Shared word runs with the corpus.
const corpus = (process.env.ATELIER_PROMPT_CORPUS ?? '').split(':').filter(Boolean);
if (!corpus.length) {
  console.log('No corpus (ATELIER_PROMPT_CORPUS is unset): only the signature markers were checked.');
} else {
  const allowed = (await readFile(join(here, 'prompt-originality.allow.txt'), 'utf8'))
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => words(l.split(' | ')[0]).join(' '));
  // Index every WARN-gram of the candidates, then stream the corpus once.
  const docs = [...texts].map(([path, text]) => ({ path, toks: words(text) }));
  const grams = new Map();
  docs.forEach((d, di) => {
    d.hits = new Array(Math.max(0, d.toks.length - WARN + 1)).fill(null);
    for (let i = 0; i + WARN <= d.toks.length; i++) {
      const key = d.toks.slice(i, i + WARN).join(' ');
      const list = grams.get(key) ?? [];
      list.push([di, i]);
      grams.set(key, list);
    }
  });
  let scanned = 0;
  for (const root of corpus) {
    for (const source of await files(root, CORPUS_EXT)) {
      const toks = [];
      await new Promise((resolve, reject) => {
        let tail = '';
        createReadStream(source, { encoding: 'utf8' })
          .on('data', (chunk) => {
            const text = tail + chunk;
            const cut = text.search(/[^a-zA-Z0-9_']*$/);
            tail = text.slice(cut);
            toks.push(...words(text.slice(0, cut)));
          })
          .on('end', () => {
            toks.push(...words(tail));
            resolve();
          })
          .on('error', reject);
      });
      for (let i = 0; i + WARN <= toks.length; i++) {
        const list = grams.get(toks.slice(i, i + WARN).join(' '));
        if (list) for (const [di, pos] of list) docs[di].hits[pos] ??= source;
      }
      scanned++;
    }
  }
  console.log(`Compared ${docs.length} files with ${scanned} corpus files.`);
  for (const d of docs) {
    for (let i = 0; i < d.hits.length; ) {
      if (!d.hits[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < d.hits.length && d.hits[j + 1]) j++;
      const length = j - i + WARN;
      const run = d.toks.slice(i, j + WARN).join(' ');
      if (!allowed.some((a) => run.includes(a) || a.includes(run))) {
        const fail = length >= MIN;
        failed ||= fail;
        console.log(`${fail ? 'FAIL' : 'warn'} ${relative(repo, d.path)}: ${length} shared words: "${run}"\n     from ${d.hits[i]}`);
      }
      i = j + 1;
    }
  }
}
console.log(failed ? 'Originality check failed.' : 'Originality check passed.');
process.exit(failed ? 1 : 0);
