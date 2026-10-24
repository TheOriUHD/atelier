import { describe, expect, it } from 'vitest';
import { SETTINGS_PAGES } from './pages.ts';

describe('the Settings list', () => {
  // The nav column is 192px: its rows are one line, and "Keyboard shortcuts" (18) wrapped on every system. Fourteen is
  // what "Keys & secrets" needs; a longer name needs a shorter word (e2e/settings.web.spec.ts measures the real thing).
  it('names every page in at most 14 characters, so it fits on one line', () => {
    for (const page of SETTINGS_PAGES) expect(page.label.length, page.label).toBeLessThanOrEqual(14);
  });
});
