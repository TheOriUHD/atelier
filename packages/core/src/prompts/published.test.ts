/**
 * The prompt pages and downloads on the documentation site are generated from the templates, the tool definitions and
 * the assembled snapshots (`__fixtures__/publish-docs.ts`). This fails when one is stale; `pnpm docs:generate`
 * (UPDATE_DOCS=1) rewrites them.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishedFiles, REPO_ROOT, strayFiles } from './__fixtures__/publish-docs.ts';

describe('published prompts', () => {
  it('match the templates, tools and snapshots they are generated from', { timeout: 120_000 }, async () => {
    const files = await publishedFiles();
    const update = !!process.env.UPDATE_DOCS;
    const stale: string[] = [];
    for (const [path, content] of files) {
      const file = join(REPO_ROOT, path);
      if (existsSync(file) && readFileSync(file, 'utf8') === content) continue;
      if (update) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      } else stale.push(path);
    }
    for (const path of strayFiles(files)) {
      if (update) rmSync(join(REPO_ROOT, path));
      else stale.push(`${path} (no longer generated)`);
    }
    expect(stale, 'Stale published files: run `pnpm docs:generate`').toEqual([]);
  });

  it('contain every template exactly once in the download', async () => {
    const files = await publishedFiles();
    const md = files.get('apps/docs/public/prompts/atelier-prompts.md')!;
    const { defaultTemplates } = await import('./templates.gen.ts');
    for (const key of Object.keys(defaultTemplates)) expect(md).toContain(`## ${key}\n`);
  });
});
