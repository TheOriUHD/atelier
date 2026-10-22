import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appError,
  defaultSettings,
  defaultUserPrefs,
  type SafeguardsOverride,
  type ScreenLockStatus,
  type Settings,
} from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { AccountPage } from './account-page.tsx';
import { setLocal } from '../auth/screen-lock.ts';
import { callsTo, emit, resetBackend, snapshot, user } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** The desktop bridge; undefined is the browser. */
const platform = vi.hoisted(() => ({ desktop: undefined as unknown }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
}));
const webLogout = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../auth/sign-in.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), logout: webLogout }));

function desktopBridge(connection: { mode: 'local' | 'server'; serverUrl: string | null }) {
  const bridge = {
    connection: { get: vi.fn(async () => connection), reset: vi.fn(() => new Promise<void>(() => {})) },
  };
  platform.desktop = bridge;
  return bridge;
}

afterEach(() => {
  platform.desktop = undefined;
  webLogout.mockClear();
});

let safeguards: Settings['safeguards'];
let person: SafeguardsOverride;

beforeEach(() => {
  safeguards = defaultSettings().safeguards;
  person = 'inherit';
  resetBackend({
    'settings.get': () => snapshot({ safeguards }),
    'account.get': () => user({ role: 'user', safeguards: person }),
    'account.sessions': () => [],
    'account.devices': () => [],
    'account.passkeys': () => [],
  });
});

/** The account and settings are loaded before the page opens, as the sign-in gate and the Settings overlay do. */
async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await client.prefetchQuery({ queryKey: keys.settings, queryFn: () => rpc().call('settings.get', {}) });
  await client.prefetchQuery({ queryKey: keys.account, queryFn: () => rpc().call('account.get', {}) });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AccountPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('Account › Sessions', () => {
  it('names each sign-in by app and system, the desktop app included', async () => {
    const at = { ip: '10.0.0.2', createdAt: 0, lastSeenAt: 0, current: false };
    resetBackend({
      'settings.get': () => snapshot({ safeguards }),
      'account.get': () => user({ role: 'user', safeguards: person }),
      'account.sessions': () => [
        { ...at, id: 's1', clientKind: 'desktop', userAgent: 'Atelier Desktop (darwin)' },
        { ...at, id: 's2', clientKind: 'desktop', userAgent: 'Atelier Desktop (win32)' },
        {
          ...at,
          id: 's3',
          clientKind: 'web',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
        },
      ],
      'account.devices': () => [],
      'account.passkeys': () => [],
    });
    await renderPage();
    for (const name of ['Atelier Desktop on macOS', 'Atelier Desktop on Windows', 'Chrome on Windows'])
      expect(await screen.findByText(name)).toBeTruthy();
  });
});

describe('Account › Content safeguards', () => {
  it('shows nothing while safeguards are off, the default', async () => {
    await renderPage();
    expect(screen.getByText('Response style')).toBeTruthy();
    expect(screen.queryByText('Content safeguards')).toBeNull();
  });

  it('shows them read-only when the administrator turned them on for everyone, with what they cover', async () => {
    safeguards = { ...safeguards, enabled: true };
    await renderPage();
    expect(screen.getByText('Content safeguards')).toBeTruthy();
    expect(screen.getByText('On, set by your administrator')).toBeTruthy();
    expect(screen.getByText('Covers explicit sexual content, hate and violent extremism.')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Content safeguards' })).toBeNull();
  });

  it('follows the per-person setting and lists the younger-person rules', async () => {
    person = 'on';
    safeguards = {
      ...safeguards,
      categories: { sexual: false, hate: false, harassment: true, selfHarm: false },
      profile: 'younger',
    };
    await renderPage();
    expect(screen.getByText('Covers harassment of private people, rules for younger people.')).toBeTruthy();
  });

  it('reads the settings a regular user gets, which hold only what applies to them', async () => {
    // Off for this person: the backend sends no categories at all.
    person = 'off';
    safeguards = {
      enabled: false,
      categories: { sexual: false, hate: false, harassment: false, selfHarm: false },
      profile: 'adult',
      crisisResources: '',
    };
    await renderPage();
    expect(screen.queryByText('Content safeguards')).toBeNull();
  });

  it('shows what applies to a regular user from their settings, without the helpline text', async () => {
    person = 'on';
    safeguards = {
      enabled: true,
      categories: { sexual: false, hate: true, harassment: false, selfHarm: false },
      profile: 'adult',
      crisisResources: '',
    };
    await renderPage();
    expect(screen.getByText('Covers hate and violent extremism.')).toBeTruthy();
  });

  it('stays hidden when they are on with every category off', async () => {
    safeguards = {
      ...safeguards,
      enabled: true,
      categories: { sexual: false, hate: false, harassment: false, selfHarm: false },
    };
    await renderPage();
    expect(screen.queryByText('Content safeguards')).toBeNull();
  });
});

describe('Account › Personality', () => {
  it('selects presets and creates, edits and deletes a named custom mode without changing response style', async () => {
    let prefs = defaultUserPrefs();
    prefs.personalization.responseStyle = 'concise';
    resetBackend({
      'settings.get': () => snapshot({}),
      'account.get': () => user({ role: 'user' }),
      'account.sessions': () => [],
      'account.devices': () => [],
      'account.passkeys': () => [],
      'prefs.get': () => prefs,
      'prefs.set': ({ value }: { value: typeof prefs.personalization.personality }) =>
        (prefs = { ...prefs, personalization: { ...prefs.personalization, personality: value } }),
    });
    await renderPage();
    expect(await screen.findByText('Atelier — helpful and pragmatic')).toBeTruthy();
    expect(screen.getByText(/Applies to new conversations; response style stays independent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'Personality' }));
    const option = await screen.findByRole('option', { name: 'Relaxed — casual, more emoji' });
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.click(option);
    await waitFor(() => expect(prefs.personalization.personality.selected).toBe('relaxed'));
    fireEvent.click(screen.getByRole('button', { name: 'Add custom mode' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Mode name' }), {
      target: { value: 'Patient tutor' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Style instructions' }), {
      target: { value: 'Ask one guiding question.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save mode' }));
    await waitFor(() => expect(prefs.personalization.personality.customModes[0]?.name).toBe('Patient tutor'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Edit mode' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Mode name' }), { target: { value: 'Tutor' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save mode' }));
    await waitFor(() => expect(prefs.personalization.personality.customModes[0]?.name).toBe('Tutor'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Delete mode' }));
    await waitFor(() => expect(prefs.personalization.personality).toEqual({ selected: 'atelier', customModes: [] }));
    expect(prefs.personalization.responseStyle).toBe('concise');
    expect(
      callsTo('prefs.set').every(
        (call) =>
          JSON.stringify((call as { path: string[] }).path) === JSON.stringify(['personalization', 'personality']),
      ),
    ).toBe(true);
  });
});

describe('Account › Instructions for Code and Cowork', () => {
  it('edits the person’s own ATELIER.md as a draft and saves it to their preferences', async () => {
    let prefs = defaultUserPrefs();
    resetBackend({
      'settings.get': () => snapshot({}),
      'account.get': () => user({ role: 'user' }),
      'account.sessions': () => [],
      'account.devices': () => [],
      'account.passkeys': () => [],
      'prefs.get': () => prefs,
      'prefs.set': ({ value }: { value: string }) =>
        (prefs = { ...prefs, personalization: { ...prefs.personalization, atelierMd: value } }),
    });
    await renderPage();
    expect(await screen.findByRole('heading', { name: 'Instructions for Code and Cowork' })).toBeTruthy();
    const field = screen.getByRole('textbox', { name: 'Your ATELIER.md' });
    fireEvent.change(field, { target: { value: '- Explain a plan before large changes.' } });
    expect(screen.getByText(/· Unsaved changes/)).toBeTruthy();
    expect(callsTo('prefs.set')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('prefs.set')).toEqual([
        { path: ['personalization', 'atelierMd'], value: '- Explain a plan before large changes.' },
      ]),
    );
    expect(prefs.personalization.atelierMd).toBe('- Explain a plan before large changes.');
  });
});

describe('Account on "Run on this computer"', () => {
  let lock: ScreenLockStatus;
  beforeEach(() => {
    setLocal(true);
    lock = { enabled: false, kind: null, autoLockMinutes: 0, locked: false, retryAt: null };
    resetBackend({
      'settings.get': () => snapshot({}),
      'account.get': () => user(),
      'lock.status': () => lock,
      'lock.set': () => (lock = { ...lock, enabled: true, kind: 'pin' }),
      'lock.clear': ({ current }: { current: string }) => {
        if (current !== '2468') throw appError('wrong_secret', 'That PIN is wrong.');
        return (lock = { ...lock, enabled: false, kind: null });
      },
      'lock.setAutoLock': ({ minutes }: { minutes: 0 | 5 | 15 | 30 | 60 }) =>
        (lock = { ...lock, autoLockMinutes: minutes }),
      'lock.lock': () => ({ ...lock, locked: true }),
    });
  });
  afterEach(() => setLocal(false));

  it('has no password, sessions or devices, only the screen lock, with honest copy', async () => {
    await renderPage();
    expect(await screen.findByRole('heading', { name: 'Screen lock' })).toBeTruthy();
    expect(screen.getByText(/Your data on this computer is not encrypted by it\./)).toBeTruthy();
    expect(screen.getByText('Off.')).toBeTruthy();
    for (const gone of ['Username', 'Password', 'Log out of all devices', 'Active sessions', 'Devices'])
      expect(screen.queryByText(gone)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull();
    expect(callsTo('account.sessions')).toEqual([]);
    expect(callsTo('account.devices')).toEqual([]);
  });

  it('sets a PIN of 4–8 digits, confirmed, and turns it off only with the current one', async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^New PIN/), { target: { value: '12a' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(await within(dialog).findByText('Use 4 to 8 digits.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/^New PIN/), { target: { value: '2468' } });
    fireEvent.change(within(dialog).getByLabelText('Confirm PIN'), { target: { value: '2469' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(await within(dialog).findByText('The PINs don’t match.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Confirm PIN'), { target: { value: '2468' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(callsTo('lock.set')).toEqual([{ lock: { kind: 'pin', secret: '2468' } }]));

    act(() => emit('lock.changed', lock));
    expect(await screen.findByText('On, with a PIN.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lock now' }));
    await waitFor(() => expect(callsTo('lock.lock')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    const off = await screen.findByRole('dialog');
    fireEvent.change(within(off).getByLabelText('Current PIN'), { target: { value: '0000' } });
    fireEvent.click(within(off).getByRole('button', { name: 'Turn off' }));
    expect(await within(off).findByText('That PIN is wrong.')).toBeTruthy();
    fireEvent.change(within(off).getByLabelText('Current PIN'), { target: { value: '2468' } });
    fireEvent.click(within(off).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(callsTo('lock.clear')).toEqual([{ current: '0000' }, { current: '2468' }]));
  });
});

describe('Account › Log out', () => {
  beforeEach(() => {
    resetBackend({
      'settings.get': () => snapshot({}),
      'account.get': () => user({ role: 'user' }),
      'account.sessions': () => [],
      'account.devices': () => [],
      'account.passkeys': () => [],
      'auth.logout': () => ({ ok: true }),
    });
  });

  it('lets anyone log out in the browser', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(webLogout).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Switch…' })).toBeNull();
  });

  it('signs the desktop app out of its server and goes back to the first-run choice', async () => {
    const bridge = desktopBridge({ mode: 'server', serverUrl: 'https://atelier.lan' });
    await renderPage();
    expect(screen.getByText('Then Atelier asks again whether to use a server or this computer.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(bridge.connection.reset).toHaveBeenCalledTimes(1));
    expect(callsTo('auth.logout')).toHaveLength(1);
    expect(webLogout).not.toHaveBeenCalled();
  });

  it('switches to this computer or another server after asking, signing out first', async () => {
    const bridge = desktopBridge({ mode: 'server', serverUrl: 'https://atelier.lan' });
    await renderPage();
    expect(await screen.findByText('https://atelier.lan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText('This app logs out of https://atelier.lan. Your chats stay on the server.'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Log out and switch' }));
    await waitFor(() => expect(bridge.connection.reset).toHaveBeenCalledTimes(1));
    expect(callsTo('auth.logout')).toHaveLength(1);
  });
});

describe('Account › Change setup on "Run on this computer"', () => {
  beforeEach(() => {
    setLocal(true);
    resetBackend({
      'settings.get': () => snapshot({}),
      'account.get': () => user(),
      'lock.status': () => ({ enabled: false, kind: null, autoLockMinutes: 0, locked: false, retryAt: null }),
    });
  });
  afterEach(() => setLocal(false));

  it('goes back to the first-run choice after saying the chats here stay, without signing anything out', async () => {
    const bridge = desktopBridge({ mode: 'local', serverUrl: null });
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change setup…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(
        'Your chats on this computer stay; choose “Run on this computer” again to get back to them.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change setup' }));
    await waitFor(() => expect(bridge.connection.reset).toHaveBeenCalledTimes(1));
    expect(callsTo('auth.logout')).toEqual([]);
  });

  it('isn’t offered in a desktop app too old to go back', async () => {
    platform.desktop = { connection: { get: vi.fn() } };
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Change setup…' })).toBeNull();
  });
});
