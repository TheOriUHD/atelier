import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerStatus } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { ComputerUseSection } from './computer-use-section.tsx';

/** The desktop bridge the section sees. */
const platform = vi.hoisted(() => ({ desktop: undefined as unknown, isMac: false, os: 'linux' }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
  get isMac() {
    return platform.isMac;
  },
  get os() {
    return platform.os;
  },
}));

const status = (patch: Partial<ComputerStatus>): ComputerStatus => ({
  available: true,
  platform: 'linux',
  session: 'x11',
  permissions: { accessibility: true, screenRecording: true },
  background: false,
  settings: { enabled: true, mode: 'background', unhideOnFinish: true, denied: [{ id: 'keepassxc', name: 'KeePassXC' }], always: {} },
  control: null,
  ...patch,
});

function show(s: ComputerStatus) {
  platform.desktop = {
    platform: s.platform,
    computer: { status: async () => s, onChanged: () => () => {}, settings: vi.fn(), apps: async () => [] },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ComputerUseSection />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  platform.isMac = false;
  platform.os = 'linux';
});

describe('Settings › System › Computer use on Linux', () => {
  it('offers “Ask per app” instead of a Background mode that the system can’t do, and says why', async () => {
    show(status({}));
    expect(await screen.findByRole('radio', { name: 'Ask per app' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Full control' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Background' })).toBeNull();
    expect(screen.getByText(/X11 only takes input through the real mouse and keyboard/)).toBeTruthy();
    // The stored mode is still the same one, and the denied list shows its Linux password managers.
    expect(screen.getByRole('radio', { name: 'Ask per app' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('KeePassXC')).toBeTruthy();
  });

  it('keeps the name Background where the system really can', async () => {
    show(status({ platform: 'win32', session: undefined, background: true }));
    expect(await screen.findByRole('radio', { name: 'Background' })).toBeTruthy();
    expect(screen.queryByText(/X11/)).toBeNull();
  });

  it('warns on a Wayland session about what Atelier can and can’t reach', async () => {
    show(status({ session: 'wayland' }));
    expect(await screen.findByText(/You are on a Wayland session/)).toBeTruthy();
    expect(screen.getByText(/only see and control apps that run through XWayland/)).toBeTruthy();
  });

  it('says it can’t tell a password field on Linux, and that no such warning shows on an X11 session about Wayland', async () => {
    show(status({}));
    expect(await screen.findByText(/can’t tell a password field from other text on Linux/)).toBeTruthy();
    expect(screen.queryByText(/Wayland session/)).toBeNull();
  });

  it('gives the reason when there is no X server at all, and nothing to switch on', async () => {
    show(status({ available: false, unavailableReason: 'This session has no X server (DISPLAY is not set), so Atelier has no screen to see and control.' }));
    await waitFor(() => expect(screen.getByText(/This session has no X server/)).toBeTruthy());
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
