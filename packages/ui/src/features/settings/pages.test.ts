import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '@atelier/protocol';
import { keys, queryClient } from '../../lib/queries.ts';
import { setLocal } from '../auth/screen-lock.ts';
import { SETTINGS_PAGES, settingsPage, visiblePages } from './pages.ts';

describe('the Settings list', () => {
  // The nav column is 192px: its rows are one line, and "Keyboard shortcuts" (18) wrapped on every system. Fifteen is
  // what "Image providers" needed (the page is "Media" now); a longer name needs a shorter word (e2e/settings.web.spec.ts measures the real thing).
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

describe('Decision models', () => {
  afterEach(() => queryClient.clear());
  const shown = (admin: boolean) => visiblePages(admin).map((p) => p.id);
  const settings = (effective: object) => queryClient.setQueryData(keys.settings, { effective, origins: {}, projectRoot: null, errors: [] });

  it('is an admin page after Models, once the settings have decision models', () => {
    settings(defaultSettings());
    const pages = shown(true);
    expect(pages[pages.indexOf('models') + 1]).toBe('decisions');
    expect(shown(false)).not.toContain('decisions');
  });

  it('is hidden on a server from before them, and until the settings are read', () => {
    expect(shown(true)).not.toContain('decisions');
    const { decisions: _, ...older } = defaultSettings();
    settings(older);
    expect(shown(true)).not.toContain('decisions');
    expect(settingsPage('decisions', true).id).toBe('general');
  });
});

describe('Limits', () => {
  afterEach(() => {
    queryClient.clear();
    setLocal(false);
  });
  const shown = (admin: boolean) => visiblePages(admin).map((p) => p.id);

  it('is an admin page, once the server says it keeps limits', () => {
    queryClient.setQueryData(keys.appInfo, { usageLimits: true });
    const pages = shown(true);
    expect(pages[pages.indexOf('users') + 1]).toBe('limits');
    expect(shown(false)).not.toContain('limits');
  });

  it('is hidden on an older server, and until it has said', () => {
    expect(shown(true)).not.toContain('limits');
    queryClient.setQueryData(keys.appInfo, {});
    expect(shown(true)).not.toContain('limits');
    expect(settingsPage('limits', true).id).toBe('general');
  });

  it('is hidden on the desktop app’s own backend, which has one person', () => {
    queryClient.setQueryData(keys.appInfo, { usageLimits: true });
    setLocal(true);
    expect(shown(true)).not.toContain('limits');
  });
});
