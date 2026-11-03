import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, defaultUserPrefs } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { GeneralPage } from './general-page.tsx';
import { callsTo, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const notification = { permission: 'default' as NotificationPermission, requestPermission: vi.fn(async () => notification.permission) };

beforeEach(() => {
  notification.permission = 'default';
  notification.requestPermission.mockClear();
  vi.stubGlobal('Notification', notification);
});
afterEach(() => vi.unstubAllGlobals());

function renderPage(prefs = defaultUserPrefs(), extra: Record<string, () => unknown> = {}) {
  resetBackend({ 'settings.get': () => snapshot(), 'models.list': () => [], 'prefs.get': () => prefs, 'prefs.set': () => prefs, ...extra });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}>
      <TooltipProvider>
        <GeneralPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('task notifications', () => {
  it('are on by default; turning one on is when the browser asks for permission', async () => {
    renderPage({ ...defaultUserPrefs(), notifications: { taskFinished: false, permissionNeeded: true } });
    const needed = await screen.findByRole('switch', { name: 'Notify me when a task needs me' });
    await waitFor(() => expect(needed.getAttribute('aria-checked')).toBe('true'));
    const finished = screen.getByRole('switch', { name: 'Notify me when a task finishes' });
    expect(finished.getAttribute('aria-checked')).toBe('false');
    expect(notification.requestPermission).not.toHaveBeenCalled();

    fireEvent.click(finished);
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['notifications', 'taskFinished'], value: true }]));
    expect(notification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('say so when the browser blocks them', async () => {
    notification.permission = 'denied';
    renderPage();
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent)).toEqual([
      expect.stringContaining('Notifications are blocked for Atelier'),
      expect.stringContaining('Notifications are blocked for Atelier'),
    ]);
  });
});

describe('the default image model', () => {
  const image = (modelId: string, extra = {}) => ({ ref: `comfy/${modelId}`, providerId: 'comfy', modelId, displayName: modelId, hidden: false, ...extra });
  const offered = (models: unknown[]) => ({ 'app.info': () => ({ imageGeneration: true }), 'imageModels.list': () => models });

  it('is chosen from the visible models, with the server’s default named', async () => {
    renderPage(defaultUserPrefs(), {
      ...offered([image('z-image'), image('sdxl', { hidden: true })]),
      'settings.get': () => snapshot({ models: { ...defaultSettings().models, defaults: { image: 'comfy/z-image' } } }),
    });
    const select = await screen.findByRole('combobox', { name: 'Default image model' });
    expect(select.textContent).toContain('Server default (z-image)');
    fireEvent.click(select);
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Server default (z-image)', 'z-image']);
  });

  it('sets the person’s own preference', async () => {
    renderPage(defaultUserPrefs(), offered([image('z-image')]));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Default image model' }));
    const option = await screen.findByRole('option', { name: 'z-image' });
    // Base UI only accepts mouse clicks that started on the option.
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.click(option);
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['models', 'image'], value: 'comfy/z-image' }]));
  });

  it('warns about a model that has gone', async () => {
    const prefs = defaultUserPrefs();
    prefs.models.image = 'comfy/gone';
    renderPage(prefs, offered([image('z-image')]));
    expect(await screen.findByText(/This model is no longer available. Your images use the server default \(z-image\)/)).toBeTruthy();
  });

  it('has nothing to show before there are image models', async () => {
    renderPage(defaultUserPrefs(), offered([]));
    await screen.findByRole('combobox', { name: 'Default model' });
    await waitFor(() => expect(callsTo('imageModels.list')).toHaveLength(1));
    expect(screen.queryByRole('combobox', { name: 'Default image model' })).toBeNull();
  });

  it('goes while an admin has image generation off', async () => {
    renderPage(defaultUserPrefs(), { ...offered([image('z-image')]), 'settings.get': () => snapshot({ imageGeneration: { enabled: false, maxImagesPerTurn: 8 } }) });
    await screen.findByRole('combobox', { name: 'Default model' });
    await waitFor(() => expect(callsTo('imageModels.list')).toHaveLength(1));
    expect(screen.queryByRole('combobox', { name: 'Default image model' })).toBeNull();
  });

  it('stays away on an older server', async () => {
    renderPage(defaultUserPrefs(), { 'app.info': () => ({}) });
    await waitFor(() => expect(callsTo('app.info')).toHaveLength(1));
    expect(screen.queryByRole('combobox', { name: 'Default image model' })).toBeNull();
    expect(callsTo('imageModels.list')).toEqual([]);
  });
});

describe('the default video model', () => {
  const model = (modelId: string, output?: 'video') => ({ ref: `fal/${modelId}`, providerId: 'fal', modelId, displayName: modelId, hidden: false, capabilities: output ? { output } : {} });
  const offered = (models: unknown[]) => ({ 'app.info': () => ({ imageGeneration: true, videoGeneration: true }), 'imageModels.list': () => models });

  it('is chosen from the video models only, apart from the pictures’ own default', async () => {
    renderPage(defaultUserPrefs(), offered([model('flux'), model('kling', 'video')]));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Default video model' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Server default (kling)', 'kling']);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
    fireEvent.click(screen.getByRole('combobox', { name: 'Default image model' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Server default (flux)', 'flux']);
  });

  it('sets the person’s own preference', async () => {
    renderPage(defaultUserPrefs(), offered([model('kling', 'video')]));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Default video model' }));
    const option = await screen.findByRole('option', { name: 'kling' });
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.click(option);
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['models', 'video'], value: 'fal/kling' }]));
  });

  it('is not there without video models, while videos are off, or on a server that cannot make them', async () => {
    renderPage(defaultUserPrefs(), offered([model('flux')]));
    await screen.findByRole('combobox', { name: 'Default image model' });
    expect(screen.queryByRole('combobox', { name: 'Default video model' })).toBeNull();
  });

  it('goes while an admin has videos off', async () => {
    renderPage(defaultUserPrefs(), { ...offered([model('kling', 'video'), model('flux')]), 'settings.get': () => snapshot({ imageGeneration: { enabled: true, maxImagesPerTurn: 8, videoEnabled: false } }) });
    await screen.findByRole('combobox', { name: 'Default image model' });
    expect(screen.queryByRole('combobox', { name: 'Default video model' })).toBeNull();
  });

  it('stays away on a server that can make pictures but not video', async () => {
    renderPage(defaultUserPrefs(), { 'app.info': () => ({ imageGeneration: true }), 'imageModels.list': () => [model('flux')] });
    await screen.findByRole('combobox', { name: 'Default image model' });
    expect(screen.queryByRole('combobox', { name: 'Default video model' })).toBeNull();
  });
});

