import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callsTo, model, resetBackend } from '../settings/test-backend.ts';
import { Composer } from './composer.tsx';
import { filterCommands, mentionAt, type SlashCommand } from './composer-menu.tsx';
import type { Attachments } from './use-attachments.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const attachments: Attachments = { items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: () => {}, restore: () => {}, uploading: false, parts: () => [] };

beforeEach(() =>
  resetBackend({
    'slash.list': () => [
      { name: 'review', description: 'Review the diff', kind: 'skill', argumentHint: '[path]' },
      { name: 'deploy', description: 'Ship it', kind: 'command' },
      { name: 'plugin:release-notes', description: 'Draft release notes', kind: 'skill' },
      // Built-ins win over a skill of the same name.
      { name: 'clear', description: 'A skill named clear', kind: 'skill' },
    ],
    'workspaces.findFiles': ({ query }: { query: string }) => (query === 'app' ? ['src/app.ts', 'app/main.ts'] : []),
  }),
);

function setup(workspaceId?: string) {
  const compact = vi.fn();
  const clear = vi.fn();
  const commands: SlashCommand[] = [
    { name: 'compact', description: 'Summarize the conversation', argumentHint: '[focus]', run: compact },
    { name: 'clear', description: 'Start a new session', run: clear },
  ];
  const onSubmit = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Composer variant="reply" attachments={attachments} model={model('fake', 'm')} streaming={false} onSubmit={onSubmit} commands={commands} workspaceId={workspaceId} />
    </QueryClientProvider>,
  );
  const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
  return {
    box,
    compact,
    clear,
    onSubmit,
    type: (value: string) => fireEvent.change(box, { target: { value } }),
    press: (key: string) => fireEvent.keyDown(box, { key }),
  };
}

const options = (name: string) => within(screen.getByRole('listbox', { name })).getAllByRole('option');
const labels = (name: string) => options(name).map((o) => o.textContent);

describe('filterCommands and mentionAt', () => {
  it('ranks names starting with the query before names containing it', () => {
    const named = (...names: string[]) => names.map((name) => ({ name, description: '' }));
    expect(filterCommands(named('plugin:review', 'rewind', 'review', 'model'), 're').map((c) => c.name)).toEqual(['rewind', 'review', 'plugin:review']);
    expect(filterCommands(named('model'), 'x')).toEqual([]);
  });

  it('finds the @mention the caret is in', () => {
    expect(mentionAt('see @src/a', 10)).toEqual({ start: 4, query: 'src/a' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('see @src/a now', 14)).toBeNull();
    expect(mentionAt('mail me@example.com', 19)).toBeNull();
  });
});

describe('slash menu', () => {
  it('lists the built-ins, then skills and commands for the workspace, and filters as you type', async () => {
    const { type } = setup('w1');
    type('/');
    await screen.findByRole('option', { name: /review/ });
    expect(labels('Commands')).toEqual([
      '/compact[focus]Summarize the conversation',
      '/clearStart a new session',
      '/review[path]Review the diff',
      '/deployShip it',
      '/plugin:release-notesDraft release notes',
    ]);
    expect(callsTo('slash.list')).toEqual([{ workspaceId: 'w1' }]);
    type('/re');
    expect(labels('Commands')).toEqual(['/review[path]Review the diff', '/plugin:release-notesDraft release notes']);
    type('/xyz');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('moves with the arrows (wrapping) and inserts a skill to be sent with its arguments', async () => {
    const { box, type, press, onSubmit } = setup();
    type('/');
    await screen.findByRole('option', { name: /review/ });
    expect(callsTo('slash.list')).toEqual([{}]);
    const selected = () => options('Commands').findIndex((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected()).toBe(0);
    expect(box.getAttribute('aria-activedescendant')).toBe(options('Commands')[0]!.id);
    press('ArrowUp');
    expect(selected()).toBe(4);
    press('ArrowDown');
    press('ArrowDown');
    press('ArrowDown');
    expect(selected()).toBe(2);
    press('Enter');
    expect(box.value).toBe('/review ');
    expect(screen.queryByRole('listbox')).toBeNull();
    type('/review src');
    press('Enter');
    expect(onSubmit).toHaveBeenCalledWith('/review src');
  });

  it('runs a built-in without arguments when picked, and completes one that takes them', async () => {
    const { box, type, press, clear, compact, onSubmit } = setup();
    type('/cl');
    press('Tab');
    expect(clear).toHaveBeenCalledWith('');
    expect(box.value).toBe('');
    type('/comp');
    fireEvent.click(screen.getByRole('option', { name: /compact/ }));
    expect(box.value).toBe('/compact ');
    type('/compact the tests');
    press('Enter');
    expect(compact).toHaveBeenCalledWith('the tests');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('closes on Esc until the text changes', async () => {
    const { type, press } = setup();
    type('/');
    await screen.findByRole('option', { name: /review/ });
    press('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    type('/d');
    expect(labels('Commands')).toEqual(['/deployShip it']);
  });
});

describe('mention menu', () => {
  it('searches the workspace’s files and inserts the chosen path', async () => {
    const { box, type, press } = setup('w1');
    type('look at @app');
    await screen.findByRole('listbox', { name: 'Files' });
    expect(callsTo('workspaces.findFiles')).toEqual([{ workspaceId: 'w1', query: 'app' }]);
    expect(labels('Files')).toEqual(['src/app.ts', 'app/main.ts']);
    press('ArrowDown');
    press('Enter');
    expect(box.value).toBe('look at @app/main.ts ');
    expect(box.selectionStart).toBe(box.value.length);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('says when nothing matches, and leaves Enter to send', async () => {
    const { type, press, onSubmit } = setup('w1');
    type('@zzz');
    expect(await screen.findByText('No matching files')).toBeTruthy();
    press('Enter');
    expect(onSubmit).toHaveBeenCalledWith('@zzz');
  });

  it('is off outside a workspace', async () => {
    const { type } = setup();
    type('@app');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(callsTo('workspaces.findFiles')).toEqual([]);
  });
});
