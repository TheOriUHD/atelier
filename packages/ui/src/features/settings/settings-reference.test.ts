/**
 * The settings reference on the documentation site (`apps/docs/.../reference/settings.md`) is generated from the
 * Settings search index, which is also what the rows in Settings render, so the page lists every setting with its
 * real label and description. This fails when the committed page is stale; `pnpm docs:generate` (UPDATE_DOCS=1)
 * rewrites it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { SETTINGS_PAGES } from './pages.ts';
import { SETTINGS_INDEX, type SettingEntry } from './search-index.ts';

const FILE = join(import.meta.dirname, '../../../../../apps/docs/src/content/docs/reference/settings.md');

/** Rows whose label says it all in Settings; the reference says what they offer. */
const EXTRA: Record<string, string> = {
  'appearance.theme': 'Light, Dark, or System (follow the operating system).',
  'appearance.chatFont': 'Atelier Serif, Atelier Sans, System, or OpenDyslexic.',
  'usage.byDay': 'A chart of tokens per day, split by Chat, Cowork and Code.',
  'system.updates': 'Where an update stands, with **Check now**, which looks for a new version right away. See [Updates](/updates/).',
  'system.version': 'The version of the desktop app you are running.',
  'models.aliases.opus': 'Which of your models answers when an agent file asks for `opus`. See [Models](/models/).',
  'models.aliases.sonnet': 'Which of your models answers when an agent file asks for `sonnet`.',
  'models.aliases.haiku': 'Which of your models answers when an agent file asks for `haiku`.',
  'models.aliases.fable': 'Which of your models answers when an agent file asks for `fable`.',
  'developer.connectorLogs': 'What each connector printed, and its connections and failures. Credentials are masked.',
};

const PAGE_NOTE: Record<string, string> = {
  system: 'Desktop app only.',
  developer: 'Admins only. These are diagnostic tools.',
};

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

export function settingsReference(): string {
  const entries = SETTINGS_INDEX as readonly SettingEntry[];
  const missing: string[] = [];
  const sections = SETTINGS_PAGES.map((page) => {
    const rows = entries.filter((e) => e.page === page.id);
    if (!rows.length) return '';
    const path = `Settings › ${page.group === 'Admin' ? 'Admin › ' : ''}${page.label}`;
    const note = PAGE_NOTE[page.id];
    const admin = page.group === 'Admin' ? 'Admins only. ' : '';
    return [
      `## ${path}`,
      '',
      `${admin}${note ?? ''}`.trim(),
      '',
      '| Setting | What it does |',
      '|---|---|',
      ...rows.map((e) => {
        const description = e.description ?? EXTRA[e.id];
        if (!description) missing.push(e.id);
        const flags = [e.admin && page.group !== 'Admin' ? 'admins only' : '', e.available ? 'only where it works' : ''].filter(Boolean);
        return `| **${cell(e.label)}**${flags.length ? ` *(${flags.join(', ')})*` : ''} | ${cell(description ?? '')} |`;
      }),
    ]
      .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
      .join('\n');
  }).filter(Boolean);
  if (missing.length) throw new Error(`Settings without a description or an entry in EXTRA: ${missing.join(', ')}`);
  const pages = new Set(SETTINGS_PAGES.map((p) => p.id));
  const orphans = entries.filter((e) => !pages.has(e.page));
  if (orphans.length) throw new Error(`Settings rows on pages that are not listed: ${orphans.map((e) => e.id).join(', ')}`);
  return `---
title: Settings reference
description: Every setting in Atelier by page, with what it does.
editUrl: false
---

<!-- GENERATED from packages/ui/src/features/settings/search-index.ts by settings-reference.test.ts. Do not edit; run \`pnpm docs:generate\`. -->

This page lists every row in Settings, with the label and description the app shows. Open Settings with ⌘, (Ctrl+,) and
use the search box at the top to jump to a row. Pages under **Admin** change how Atelier behaves for everyone on this
backend; on the desktop app running on your own computer you are the admin. Pages and rows the signed-in person may not
see are hidden in the app.

${sections.join('\n\n')}
`;
}

it('the settings reference page is up to date', () => {
  const text = settingsReference();
  if (process.env.UPDATE_DOCS) {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, text);
  }
  expect(existsSync(FILE) ? readFileSync(FILE, 'utf8') : null, 'Stale settings reference: run `pnpm docs:generate`').toBe(text);
});
