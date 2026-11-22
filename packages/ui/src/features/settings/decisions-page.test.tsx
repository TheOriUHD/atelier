import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type DecisionComparison, type DecisionServiceConfig, type DecisionSource, type DecisionStatus, type Settings, type SettingsPath } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { setPath } from '../../lib/json-path.ts';
import { keys, useLiveQueries } from '../../lib/queries.ts';
import { DecisionsPage } from './decisions-page.tsx';
import { backend, callsTo, emit, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const nimble: DecisionSource = { id: 'text:ollama:nimble', label: 'nimble', provider: 'Ollama', local: true };
const jev: DecisionSource = { id: 'service:typesafe:jev-latest', label: 'jev-latest', provider: 'TypeSafe Jev', local: false };
const typesafe: DecisionServiceConfig = { id: 'typesafe', name: 'TypeSafe Jev', type: 'systemone', baseUrl: 'https://api.typesafe.ai', apiKey: '${secret:decision-service-typesafe}', models: ['jev-latest'], preset: 'typesafe', enabled: true };

const comparison = (extra: Partial<DecisionComparison> = {}): DecisionComparison => ({
  checked: 120,
  bothAllowed: 97,
  wronglyAllowed: 3,
  leftToReviewer: 20,
  approved: 0,
  medianMs: 84,
  since: new Date(2026, 10, 20, 9, 0).getTime(),
  misses: [{ at: new Date(2026, 10, 21, 14, 25).getTime(), tool: 'Bash', summary: 'rm -rf build && npm publish', verdict: 'Publishes a package: needs the person.' }],
  ...extra,
});

const status = (extra: Partial<DecisionStatus> = {}): DecisionStatus => ({
  enabled: true,
  source: nimble,
  sources: [nimble, jev],
  chosen: null,
  comparison: comparison(),
  problems: [{ provider: 'OpenRouter', error: 'The key was refused.' }],
  ...extra,
});

function LiveQueries() {
  useLiveQueries();
  return null;
}

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

function renderPage(decisions: Partial<Settings['decisions']> = {}, current: DecisionStatus = status()) {
  let settings = snapshot({ decisions: { ...defaultSettings().decisions, services: [typesafe], ...decisions } });
  resetBackend({
    'settings.get': () => settings,
    'settings.set': ({ path, value }: { path: SettingsPath; value: unknown }) => {
      settings = { ...settings, effective: setPath(settings.effective, path, value) };
      return { ok: true };
    },
    'settings.reset': () => ({ ok: true }),
    'secrets.list': () => [{ id: 'decision-service-typesafe', label: 'key', kind: 'api_key', masked: '••••7a1c', createdAt: 0, updatedAt: 0, usedBy: [] }],
    'decisions.status': () => current,
    'decisions.testService': () => ({ ok: true, models: ['s1-fast', 's1-pro'], ms: 84 }),
    'decisions.saveService': () => current,
    'decisions.removeService': () => ({ ...current, sources: [nimble] }),
    'decisions.resetComparison': () => ({ ...current, comparison: comparison({ checked: 0, bothAllowed: 0, wronglyAllowed: 0, leftToReviewer: 0, medianMs: null, misses: [] }) }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.settings, settings);
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <LiveQueries />
        <DecisionsPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const row = (id: string) => within(document.querySelector<HTMLElement>(`[data-setting-row="${id}"]`)!);

describe('the decision model', () => {
  it('shows what Automatic picked, the choices marked local or paid, and the providers it couldn’t ask', async () => {
    renderPage();
    expect(await screen.findByText('Automatic: nimble on Ollama.')).toBeTruthy();
    expect(screen.getByText('Couldn’t ask OpenRouter: The key was refused.')).toBeTruthy();
    const picker = screen.getByRole('combobox', { name: 'Decision model' });
    expect(picker.textContent).toContain('Automatic');
    fireEvent.click(picker);
    expect((await screen.findByRole('option', { name: /nimble · Ollama · local/ })).textContent).toContain('local');
    expect(screen.getByRole('option', { name: /jev-latest · TypeSafe Jev · paid/ })).toBeTruthy();
  });

  it('saves a chosen model, and Automatic removes the choice', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Decision model' }));
    pick(await screen.findByRole('option', { name: /jev-latest/ }));
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['decisions', 'source'], value: jev.id }]));

    fireEvent.click(screen.getByRole('combobox', { name: 'Decision model' }));
    pick(await screen.findByRole('option', { name: 'Automatic' }));
    await waitFor(() => expect(callsTo('settings.reset')).toEqual([{ layer: 'global', path: ['decisions', 'source'] }]));
  });

  it('says how to get one when there is none', async () => {
    renderPage({}, status({ source: null, sources: [], comparison: comparison({ checked: 0 }), problems: [] }));
    expect(await screen.findByText(/None yet\. Pull/)).toBeTruthy();
    expect(row('decisions.source').getByText(/Ollama 0\.35 or later, or add a service below/)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Decision model' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try it' }).hasAttribute('disabled')).toBe(true);
  });

  it('says when Automatic leaves the paid ones alone', async () => {
    renderPage({}, status({ source: null, sources: [jev] }));
    expect(await screen.findByText('Automatic picks no paid model by itself: choose one to use it.')).toBeTruthy();
  });

  it('follows decisions.changed', async () => {
    renderPage();
    await screen.findByText('Automatic: nimble on Ollama.');
    act(() => emit('decisions.changed', status({ source: jev, chosen: null })));
    expect(await screen.findByText('Automatic: jev-latest on TypeSafe Jev.')).toBeTruthy();
  });

  it('turned off, offers nothing else', async () => {
    renderPage();
    await screen.findByText('Automatic: nimble on Ollama.');
    fireEvent.click(screen.getByRole('switch', { name: 'Use decision models' }));
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['decisions', 'enabled'], value: false }]));
    expect(screen.queryByRole('combobox', { name: 'Decision model' })).toBeNull();
    expect(screen.queryByText('Decision services')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Auto mode check' })).toBeNull();
  });

  it('opens the Decide window from Try it', async () => {
    renderPage();
    await screen.findByText('Automatic: nimble on Ollama.');
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    expect(await screen.findByRole('dialog', { name: 'Decide' })).toBeTruthy();
  });
});

describe('decision services', () => {
  it('lists each with its address, models and masked key', async () => {
    renderPage();
    expect(await screen.findByText('api.typesafe.ai · jev-latest · Key ••••7a1c')).toBeTruthy();
  });

  it('adds one from a preset: tests it, then saves it', async () => {
    renderPage({ services: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add service' }));
    const choose = await screen.findByRole('dialog', { name: 'Add decision service' });
    expect(within(choose).getByText(/Open-weight decision models/)).toBeTruthy();
    fireEvent.click(within(choose).getByRole('button', { name: /Decision Models/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Add Decision Models' });
    expect((within(dialog).getByRole('textbox', { name: 'Address' }) as HTMLInputElement).value).toBe('https://api.decisionmodels.io');
    expect((within(dialog).getByRole('textbox', { name: 'Models' }) as HTMLInputElement).value).toBe('s1-fast, s1-pro');
    expect(within(dialog).getByRole('button', { name: 'Get a key' })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: ' dm-key ' } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText('It answered in 84 ms. Models: s1-fast, s1-pro.')).toBeTruthy();
    const draft = { name: 'Decision Models', type: 'systemone', baseUrl: 'https://api.decisionmodels.io', apiKey: 'dm-key', models: ['s1-fast', 's1-pro'], preset: 'decisionmodels' };
    expect(callsTo('decisions.testService')).toEqual([draft]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add service' }));
    await waitFor(() => expect(callsTo('decisions.saveService')).toEqual([draft]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Decision Models' })).toBeNull());
  });

  it('shows why a test failed, and wants an address for another server', async () => {
    renderPage({ services: [] });
    backend.handlers['decisions.testService'] = () => ({ ok: false, models: [], error: 'Nothing answers at that address.' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add service' }));
    fireEvent.click(await screen.findByRole('button', { name: /Another System One server/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Another System One server' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText('Give it a name.')).toBeTruthy();
    expect(within(dialog).getByText('Enter its address, such as https://api.example.com.')).toBeTruthy();
    expect(callsTo('decisions.testService')).toEqual([]);

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Basement' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Address' }), { target: { value: 'http://192.168.1.4:8080/v1/' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText('Nothing answers at that address.')).toBeTruthy();
    expect(callsTo('decisions.testService')).toEqual([{ name: 'Basement', type: 'systemone', baseUrl: 'http://192.168.1.4:8080', preset: 'custom' }]);
  });

  it('edits one and keeps the saved key unless it is replaced', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'TypeSafe Jev options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit TypeSafe Jev' });
    expect(within(dialog).getByText('••••7a1c')).toBeTruthy();
    expect(within(dialog).getByText(/The saved key stays unless you replace it/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Models' }), { target: { value: 'jev-latest, jev-1.14.0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('decisions.saveService')).toEqual([{ id: 'typesafe', name: 'TypeSafe Jev', type: 'systemone', baseUrl: 'https://api.typesafe.ai', models: ['jev-latest', 'jev-1.14.0'], preset: 'typesafe' }]),
    );
  });

  it('tests one from its menu', async () => {
    renderPage();
    backend.handlers['decisions.testService'] = () => ({ ok: true, models: ['jev-latest'] });
    fireEvent.click(await screen.findByRole('button', { name: 'TypeSafe Jev options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Test' }));
    expect(await screen.findByText('It answered. Model: jev-latest.')).toBeTruthy();
    expect(callsTo('decisions.testService')).toEqual([{ id: 'typesafe', name: 'TypeSafe Jev', type: 'systemone', baseUrl: 'https://api.typesafe.ai', models: ['jev-latest'], preset: 'typesafe' }]);
  });

  it('removes one after asking', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'TypeSafe Jev options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove TypeSafe Jev?' });
    expect(callsTo('decisions.removeService')).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(callsTo('decisions.removeService')).toEqual([{ id: 'typesafe' }]));
  });
});

describe('Auto mode check', () => {
  it('compares by default, and says what the comparison found', async () => {
    renderPage();
    const group = await screen.findByRole('radiogroup', { name: 'Auto mode check' });
    expect(within(group).getByRole('radio', { name: 'Compare with the reviewer' }).getAttribute('aria-checked')).toBe('true');
    expect(await screen.findByText(/^Compared on 120 actions since .*: both allowed 97, it left 20 to the reviewer, it would have let through 3 the reviewer stopped\.$/)).toBeTruthy();
    expect(screen.getByText('It usually answers in 84 ms.')).toBeTruthy();
    const misses = screen.getByRole('list', { name: 'What it would have let through' });
    expect(within(misses).getByText('Bash')).toBeTruthy();
    expect(within(misses).getByText('rm -rf build && npm publish')).toBeTruthy();
    expect(within(misses).getByText('The reviewer: Publishes a package: needs the person.')).toBeTruthy();
    // Letting it approve is worded with what it got wrong so far.
    expect(within(group).getByText('In the comparison so far it would have let through 3 actions the reviewer stopped.')).toBeTruthy();
    expect(screen.queryByText(/run without the reviewer/)).toBeNull();
  });

  it('saves the choice', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: 'Approve what it is sure of' }));
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['decisions', 'autoMode'], value: 'approve' }]));
  });

  it('in approve mode, counts what it let run', async () => {
    renderPage({ autoMode: 'approve' }, status({ comparison: comparison({ approved: 340, wronglyAllowed: 0 }) }));
    expect(await screen.findByText('It let 340 actions run without the reviewer.')).toBeTruthy();
    expect(screen.queryByText(/In the comparison so far/)).toBeNull();
  });

  it('starts the comparison again after asking', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Reset the comparison?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(callsTo('decisions.resetComparison')).toEqual([{}]));
    expect(await screen.findByText('Nothing compared yet. This fills in as Auto mode reviews actions.')).toBeTruthy();
  });
});

describe('what else uses it', () => {
  it('turns the Decide tool and the small choices off', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: 'Let the assistant sort many things at once' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Use it for Atelier’s small choices' }));
    await waitFor(() =>
      expect(callsTo('settings.set')).toEqual([
        { layer: 'global', path: ['decisions', 'tool'], value: false },
        { layer: 'global', path: ['decisions', 'helpers'], value: false },
      ]),
    );
  });
});
