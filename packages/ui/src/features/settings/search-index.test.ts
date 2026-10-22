import { describe, expect, it, vi } from 'vitest';
import { SETTINGS_PAGES } from './pages.ts';
import { SETTINGS_INDEX, searchSettings } from './search-index.ts';

/** The desktop bridge; undefined is the browser. */
const platform = vi.hoisted(() => ({ desktop: undefined as unknown }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
}));

const ids = (query: string, admin = true) => searchSettings(query, admin).map((e) => e.id);

describe('settings search index', () => {
  it('has unique ids on pages that exist', () => {
    const pages = new Set(SETTINGS_PAGES.map((p) => p.id));
    expect(new Set(SETTINGS_INDEX.map((e) => e.id)).size).toBe(SETTINGS_INDEX.length);
    for (const entry of SETTINGS_INDEX) expect(pages.has(entry.page)).toBe(true);
  });

  it('returns nothing for an empty query', () => {
    expect(searchSettings('', true)).toEqual([]);
    expect(searchSettings('   ', true)).toEqual([]);
  });

  it('matches labels, descriptions and keywords case-insensitively', () => {
    expect(ids('THEME')).toContain('appearance.theme');
    for (const query of ['personality', 'custom modes', 'emoji', 'Technical'])
      expect(ids(query, false)).toContain('personalization.personality');
    expect(ids('composer columns')).toEqual(['appearance.transcriptWidth']);
    expect(ids('dark mode')).toEqual(['appearance.theme']);
    expect(ids('system prompt')).toContain('personalization.instructions');
  });

  it('requires every word to match somewhere', () => {
    expect(ids('font dyslexic')).toEqual(['appearance.chatFont', 'appearance.interfaceFont']);
    expect(ids('font nonsense')).toEqual([]);
  });

  it('matches the page name, so a page lists all its rows', () => {
    expect(ids('server')).toContain('server.signup');
    expect(ids('account')).toEqual(
      expect.arrayContaining([
        'profile.avatar',
        'profile.callMe',
        'personalization.instructions',
        'account.sessions',
        'account.devices',
      ]),
    );
  });

  it('ranks label prefixes, then label matches, then other matches', () => {
    expect(ids('trans')).toEqual(['appearance.textSize', 'appearance.transcriptWidth', 'code.transcriptView']);
    // "Small model" has it in the label; the aliases only match through the page name.
    expect(ids('model').indexOf('models.defaults.small')).toBeLessThan(ids('model').indexOf('models.aliases.opus'));
    expect(ids('provider')[0]).toBe('providers.add');
  });

  it('finds admin rows only for admins', () => {
    expect(ids('users')).toContain('users.list');
    expect(ids('invite')).toEqual(expect.arrayContaining(['users.invites', 'server.signup']));
    const adminPages = new Set(SETTINGS_PAGES.filter((p) => p.group === 'Admin').map((p) => p.id));
    for (const query of [
      'users',
      'invite',
      'provider',
      'model',
      'web search',
      'sign-up',
      'approve',
      'rules',
      'agents.md',
      'permission mode',
    ]) {
      expect(searchSettings(query, false).every((e) => !adminPages.has(e.page))).toBe(true);
    }
    // Their own always-allowed rules are there, the system's are not.
    expect(ids('rules', false)).toEqual(['prefs.permissions.allow']);
    expect(ids('rules')).toEqual(
      expect.arrayContaining(['prefs.permissions.allow', 'permissions.allow', 'permissions.ask', 'permissions.deny']),
    );
    expect(ids('agents.md')).toEqual(['instructions.system', 'prompts.organizationInstructions']);
    expect(ids('agents.md', false)).toEqual([]);
    expect(ids('syntax')).toEqual(['code.syntaxTheme']);
    // Their own default model is still there.
    expect(ids('default model', false)).toEqual(['prefs.models.chat']);
    expect(ids('default model').slice(0, 2)).toEqual(['prefs.models.chat', 'models.defaults.chat']);
    expect(ids('default model for everyone')[0]).toBe('models.defaults.chat');
    expect(ids('small model memory')).toEqual(['models.defaults.small']);
  });

  it('finds admin rows on everyone’s pages only for admins', () => {
    expect(ids('skills', false)).toContain('skills.list');
    // Everyone connects their own GitHub account; installing from GitHub and the OAuth app are the admin's.
    expect(ids('github', false)).toEqual(['cloud.github', 'cloud.codespaces']);
    expect(ids('github')).toEqual(
      expect.arrayContaining(['cloud.github', 'cloud.github.clientId', 'skills.install', 'plugins.marketplace']),
    );
    expect(ids('oauth', false)).toEqual([]);
    expect(ids('price', false)).toEqual([]);
    expect(ids('price')).toEqual(['usage.prices']);
    expect(ids('npx skills', false)).toEqual(['skills.list']);
    expect(ids('marketplace', false)).toEqual([]);
    expect(ids('ssh', false)).toEqual(['folders.ssh', 'folders.list']);
  });

  it('finds passkeys only in a browser that can use them', () => {
    expect(ids('passkey')).toEqual([]);
    vi.stubGlobal('PublicKeyCredential', vi.fn());
    try {
      expect(ids('passkey', false)).toEqual(['account.passkeys']);
      expect(ids('security key', false)).toEqual(['account.passkeys']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('finds Sign out for everyone, and the way back to the first-run choice only in the desktop app', () => {
    expect(ids('sign out', false)).toContain('account.signOut');
    expect(ids('switch server', false)).toEqual([]);
    platform.desktop = { connection: { reset: () => {} } };
    try {
      expect(ids('switch server', false)).toEqual(['account.server']);
    } finally {
      platform.desktop = undefined;
    }
  });

  it('finds this computer’s System rows only in the desktop app', () => {
    expect(ids('launch at login', false)).toEqual([]);
    expect(ids('beta')).toEqual([]);
    platform.desktop = {};
    try {
      expect(ids('launch at login', false)).toEqual(['system.launchAtLogin']);
      expect(ids('beta', false)).toEqual(['system.updateChannel']);
      expect(ids('upgrade', false)).toEqual(['system.updates']);
      expect(ids('version', false)).toEqual(expect.arrayContaining(['system.version', 'system.updates']));
      expect(ids('finder', false)).toEqual(['system.dataFolder']);
    } finally {
      platform.desktop = undefined;
    }
  });

  it('finds connectors and secrets for admins only', () => {
    expect(ids('mcp')).toContain('connectors.list');
    expect(ids('import claude code')).toContain('connectors.list');
    expect(ids('rotate')).toEqual(['secrets.list']);
    for (const query of ['mcp', 'connectors', 'api key', 'rotate']) expect(ids(query, false)).toEqual([]);
  });
});
