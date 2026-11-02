import { afterEach, describe, expect, it } from 'vitest';
import { keys, queryClient } from '../../lib/queries.ts';
import { SETTINGS_PAGES, settingsPage, visiblePages } from './pages.ts';

describe('the Settings list', () => {
  // The nav column is 192px: its rows are one line, and "Keyboard shortcuts" (18) wrapped on every system. Fifteen is
  // what "Image providers" needs; a longer name needs a shorter word (e2e/settings.web.spec.ts measures the real thing).
  it('names every page in at most 15 characters, so it fits on one line', () => {
    for (const page of SETTINGS_PAGES) expect(page.label.length, page.label).toBeLessThanOrEqual(15);
  });
});

describe('Image providers', () => {
  afterEach(() => queryClient.clear());
  const shown = (admin: boolean) => visiblePages(admin).map((p) => p.id);

  it('is an admin page beside Providers, once the backend says it can make images', () => {
    queryClient.setQueryData(keys.appInfo, { imageGeneration: true });
    const pages = shown(true);
    expect(pages[pages.indexOf('providers') + 1]).toBe('image-providers');
    expect(shown(false)).not.toContain('image-providers');
  });

  it('is hidden on an older server, and until it has said', () => {
    expect(shown(true)).not.toContain('image-providers');
    queryClient.setQueryData(keys.appInfo, {});
    expect(shown(true)).not.toContain('image-providers');
    // A link to it lands on a page that exists.
    expect(settingsPage('image-providers', true).id).toBe('general');
  });
});
