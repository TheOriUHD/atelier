import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElicitationRequest, PendingInteraction, PermissionRequest, QuestionRequest } from '@atelier/protocol';
import { isMac, openExternal } from '../../lib/platform.ts';
import { planComments } from './plan-comments.ts';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { InteractionCard, answerText, elicitationContent, elicitationFields } from './interaction-card.tsx';
import { WorkspaceRoot } from './tool-cards.tsx';

/** A prompt in a Code session with a folder, where "always" can mean the project. */
const inProject = (pending: PendingInteraction) => (
  <WorkspaceRoot.Provider value="/work/app">
    <InteractionCard sessionId="s" pending={pending} />
  </WorkspaceRoot.Provider>
);

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

vi.mock('../../lib/platform.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), openExternal: vi.fn() }));

beforeEach(() => {
  planComments.clear('s');
  vi.mocked(openExternal).mockClear();
  resetBackend({ 'chat.respond': () => ({ ok: true }) });
});

const permission = (request: Partial<PermissionRequest>): PendingInteraction => ({
  kind: 'permission',
  id: 'i1',
  payload: { callId: 'c1', toolName: 'Bash', input: { command: 'npm test' }, reason: 'Bash needs your approval.', suggestedRule: 'Bash(npm test *)', ...request },
});

const question = (questions: QuestionRequest['questions']): PendingInteraction => ({ kind: 'question', id: 'i1', payload: { callId: 'c1', questions } });

/** ⌘↵ (Ctrl+Enter elsewhere), with Shift when asked. */
const modEnter = (shift = false) => fireEvent.keyDown(document.body, { key: 'Enter', metaKey: isMac, ctrlKey: !isMac, shiftKey: shift });

/** The answers sent with chat.respond. */
const answers = () => callsTo('chat.respond').map((c) => (c as { answer: unknown }).answer);

describe('changing folder', () => {
  const folder = (input: Record<string, unknown>) =>
    permission({ toolName: 'ChangeDirectory', input: { path: '/work/api', reason: 'The bug is in the API repository.', from: '/work/app', host: null, ...input } });

  it('asks for the folder the agent named, which can be corrected before moving', async () => {
    render(<InteractionCard sessionId="s" pending={folder({})} />);
    const card = screen.getByRole('region', { name: 'Work in another folder?' });
    expect(card.textContent).toContain('The bug is in the API repository.');
    expect(card.textContent).toContain('Now in /work/app');
    const field = within(card).getByRole<HTMLInputElement>('textbox', { name: 'Folder' });
    expect(field.value).toBe('/work/api');
    fireEvent.change(field, { target: { value: ' /work/api-v2 ' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Move here' }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', path: '/work/api-v2' }]));
  });

  it('lets the person choose when no folder was named, and stay where they are', async () => {
    render(<InteractionCard sessionId="s" pending={folder({ path: '' })} />);
    const card = screen.getByRole('region', { name: 'Choose a folder to work in' });
    expect(within(card).getByRole<HTMLButtonElement>('button', { name: 'Move here' }).disabled).toBe(true);
    fireEvent.click(within(card).getByRole('button', { name: 'Stay here' }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'deny' }]));
  });

  it('names the SSH host a path is typed for, and has no Browse there', () => {
    render(<InteractionCard sessionId="s" pending={folder({ host: 'devbox', path: '~/api' })} />);
    expect(screen.getByRole('textbox', { name: 'Folder on devbox' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull();
  });
});

describe('permission prompt', () => {
  it('allows once, or denies', async () => {
    render(<InteractionCard sessionId="s" pending={permission({})} />);
    const card = screen.getByRole('region', { name: 'Allow Atelier to run this command?' });
    expect(card.textContent).toContain('npm test');
    // The card takes focus, never a button: an Enter can't approve by accident.
    expect(document.activeElement).toBe(card);
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(callsTo('chat.respond')).toEqual([{ sessionId: 's', interactionId: 'i1', answer: { behavior: 'allow' } }]));
  });

  it('says what the command is for in its title', () => {
    render(<InteractionCard sessionId="s" pending={permission({ input: { command: 'npm test', description: 'Run the unit tests' } })} />);
    expect(screen.getByRole('region', { name: 'Allow Atelier to run Run the unit tests?' })).toBeTruthy();
  });

  it('always allows for the project from its own button', async () => {
    render(inProject(permission({})));
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', remember: 'project' }]));
  });

  it('in a chat (no folder), always allows the connector tool for the person, and offers this conversation instead of a project', async () => {
    render(<InteractionCard sessionId="s" pending={permission({ toolName: 'mcp__github__list_commits', input: { owner: 'a', repo: 'b' }, suggestedRule: 'mcp__github__list_commits' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Where to always allow' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Allow in this conversation', 'Always allow everywheremcp__github__list_commits']);
    fireEvent.keyDown(menu, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', remember: 'always' }]));
  });

  it('answers to its keys: 1 denies, 2 always allows, 3 and ⌘↵ allow once, Esc denies, ⇧⌘↵ always allows', async () => {
    const { unmount } = render(<InteractionCard sessionId="s" pending={permission({})} />);
    fireEvent.keyDown(screen.getByRole('region'), { key: '3' });
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow' }]));
    unmount();
    resetBackend({ 'chat.respond': () => ({ ok: true }) });
    const second = render(<InteractionCard sessionId="s" pending={permission({})} />);
    fireEvent.keyDown(screen.getByRole('region'), { key: '1' });
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'deny' }]));
    second.unmount();
    resetBackend({ 'chat.respond': () => ({ ok: true }) });
    const third = render(<InteractionCard sessionId="s" pending={permission({})} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'deny' }]));
    third.unmount();
    resetBackend({ 'chat.respond': () => ({ ok: true }) });
    render(inProject(permission({})));
    modEnter(true);
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', remember: 'project' }]));
  });

  it('leaves digits to a text field', () => {
    render(<InteractionCard sessionId="s" pending={permission({})} />);
    const box = document.createElement('textarea');
    screen.getByRole('region').append(box);
    fireEvent.keyDown(box, { key: '1' });
    expect(callsTo('chat.respond')).toEqual([]);
  });

  it('leaves focus in a message box with text in it', () => {
    const box = document.createElement('textarea');
    document.body.append(box);
    box.value = 'and then';
    box.focus();
    render(<InteractionCard sessionId="s" pending={permission({})} />);
    expect(document.activeElement).toBe(box);
    box.remove();
  });

  it('shows every argument of a connector’s tool', () => {
    render(<InteractionCard sessionId="s" pending={permission({ toolName: 'mcp__mail__send', input: { to: 'boss@example.com', subject: 'Hi', body: 'Quitting' } })} />);
    const text = screen.getByRole('region').textContent!;
    for (const part of ['"to": "boss@example.com"', '"subject": "Hi"', '"body": "Quitting"']) expect(text).toContain(part);
  });

  it('denies', async () => {
    render(<InteractionCard sessionId="s" pending={permission({})} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'deny' }]));
  });

  it.each([
    ['Allow for this session', 'session'],
    ['Always allow in this project Bash(npm test *)', 'project'],
    ['Always allow everywhere Bash(npm test *)', 'always'],
  ])('remembers “%s” as %s', async (name, remember) => {
    render(inProject(permission({})));
    fireEvent.click(screen.getByRole('button', { name: 'Where to always allow' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByText('Bash(npm test *)')).toHaveLength(2);
    fireEvent.click(within(menu).getByRole('menuitem', { name }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', remember }]));
  });

  it('shows a dangerous command in red and only allows it once', () => {
    render(<InteractionCard sessionId="s" pending={permission({ input: { command: 'sudo rm -rf /' }, warning: 'runs as root' })} />);
    expect(screen.getByRole('alert').textContent).toBe('runs as root');
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Where to always allow' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Always allow' })).toBeNull();
  });

  it('shows an Edit as a diff', () => {
    render(
      <InteractionCard
        sessionId="s"
        pending={permission({ toolName: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, suggestedRule: 'Edit(/repo/**)' })}
      />,
    );
    const card = screen.getByRole('region', { name: 'Allow Atelier to edit /repo/a.ts?' });
    expect([...card.querySelectorAll('[data-kind]')].map((r) => [r.getAttribute('data-kind'), r.textContent])).toEqual([
      ['remove', '-const a = 1;'],
      ['add', '+const a = 2;'],
    ]);
  });

  it('names the sub-agent that asks', () => {
    render(<InteractionCard sessionId="s" pending={permission({ agent: 'Write notes' })} />);
    expect(screen.getByRole('region', { name: 'Allow sub-agent “Write notes” to run this command?' })).toBeTruthy();
  });
});

describe('plan approval', () => {
  const plan = permission({ toolName: 'ExitPlanMode', input: { plan: '## Steps\n1. Write the test' }, reason: 'Approve the plan to start making changes.', suggestedRule: '' });
  const proposed = (onOpenPlan = vi.fn()) => {
    render(<InteractionCard sessionId="s" pending={plan} onOpenPlan={onOpenPlan} />);
    return { card: screen.getByRole('region', { name: 'Atelier proposed a plan' }), onOpenPlan };
  };

  it('proposes the plan and opens it in the Plan pane instead of reading it inline', () => {
    const { card, onOpenPlan } = proposed();
    expect(within(card).queryByRole('heading', { name: 'Steps' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Open plan' }));
    expect(onOpenPlan).toHaveBeenCalledTimes(1);
  });

  it('shows the plan in the card when there is no pane for it', () => {
    render(<InteractionCard sessionId="s" pending={plan} />);
    const card = screen.getByRole('region', { name: 'Atelier proposed a plan' });
    expect(within(card).getByRole('heading', { name: 'Steps' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Open plan' })).toBeNull();
  });

  it('accepts and goes to auto mode, or accepts and asks about each edit', async () => {
    proposed();
    fireEvent.click(screen.getByRole('button', { name: 'Accept and auto mode' }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', mode: 'auto' }]));
  });

  it('accepts with edits still asked', async () => {
    proposed();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', mode: 'default' }]));
  });

  it('offers the other way to accept behind the chevron', async () => {
    proposed();
    fireEvent.click(screen.getByRole('button', { name: 'Other ways to accept' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Accept and auto-accept edits/ }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', mode: 'acceptEdits' }]));
  });

  it('rejects without a message', async () => {
    proposed();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'deny' }]));
  });

  it('revises with what the person typed, and with the comments they left on the plan', async () => {
    planComments.add('s', 'Write the test', 'Also cover the empty case');
    proposed();
    expect(screen.getByText(/1 comment on the plan will go with your revision/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revise…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'What should change' }), { target: { value: '  Update the docs too  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send revision' }));
    await waitFor(() =>
      expect(answers()).toEqual([{ behavior: 'deny', message: 'Update the docs too\n\nComments on the plan:\n- On “Write the test”: Also cover the empty case' }]),
    );
    expect(planComments.get('s')).toEqual([]);
  });

  it('answers to its keys: ⌘↵ accepts and goes to auto mode, ⇧⌘↵ accepts, Esc opens the revision field', async () => {
    const first = render(<InteractionCard sessionId="s" pending={plan} onOpenPlan={() => {}} />);
    modEnter();
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', mode: 'auto' }]));
    first.unmount();
    resetBackend({ 'chat.respond': () => ({ ok: true }) });
    const second = render(<InteractionCard sessionId="s" pending={plan} onOpenPlan={() => {}} />);
    modEnter(true);
    await waitFor(() => expect(answers()).toEqual([{ behavior: 'allow', mode: 'default' }]));
    second.unmount();
    render(<InteractionCard sessionId="s" pending={plan} onOpenPlan={() => {}} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(await screen.findByRole('textbox', { name: 'What should change' })).toBeTruthy();
  });
});

describe('questions', () => {
  const color = {
    question: 'Which color?',
    header: 'Color',
    multiSelect: false,
    options: [
      { label: 'Red', description: 'Warm' },
      { label: 'Blue', description: 'Cool' },
    ],
  };
  const places = {
    question: 'Where?',
    header: 'Places',
    multiSelect: true,
    options: [
      { label: 'CLI', description: '' },
      { label: 'Web', description: '' },
      { label: 'Logs', description: '' },
    ],
  };

  it('submits once every question has an answer, keyed by question text', async () => {
    render(<InteractionCard sessionId="s" pending={question([color, places])} />);
    const submit = screen.getByRole('button', { name: 'Submit' });
    fireEvent.click(screen.getByRole('radio', { name: /Red/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Blue/ }));
    expect(submit.hasAttribute('disabled')).toBe(true);
    // Multi-select: chosen labels in option order, then the person's own text.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Web' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'CLI' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer to “Where?”' }), { target: { value: 'Email' } });
    fireEvent.click(submit);
    await waitFor(() => expect(answers()).toEqual([{ answers: { 'Which color?': 'Blue', 'Where?': 'CLI, Web, Email' } }]));
  });

  it('takes a typed answer instead of an option', async () => {
    render(<InteractionCard sessionId="s" pending={question([color])} />);
    fireEvent.click(screen.getByRole('radio', { name: /Red/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    expect((screen.getByRole('radio', { name: /Red/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer to “Which color?”' }), { target: { value: 'Teal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(answers()).toEqual([{ answers: { 'Which color?': 'Teal' } }]));
  });

  it('numbers the options of a single question, and a digit picks one', async () => {
    render(<InteractionCard sessionId="s" pending={question([color])} />);
    expect(screen.getByRole('radio', { name: /Blue/ }).closest('label')!.textContent).toContain('2');
    fireEvent.keyDown(screen.getByRole('region'), { key: '2' });
    expect((screen.getByRole('radio', { name: /Blue/ }) as HTMLInputElement).checked).toBe(true);
    modEnter();
    await waitFor(() => expect(answers()).toEqual([{ answers: { 'Which color?': 'Blue' } }]));
  });

  it('skips with no answers', async () => {
    render(<InteractionCard sessionId="s" pending={question([color])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(answers()).toEqual([{ answers: {} }]));
  });

  it('builds an answer from the choice', () => {
    expect(answerText(places, { picked: ['Logs', 'CLI'], other: '  ' })).toBe('CLI, Logs');
    expect(answerText(color, { picked: [], other: null })).toBe('');
  });
});

describe('connector requests (elicitation)', () => {
  const ask = (payload: ElicitationRequest): PendingInteraction => ({ kind: 'elicitation', id: 'i1', payload });
  const schema = {
    type: 'object',
    properties: {
      email: { type: 'string', title: 'Email', format: 'email', description: 'Where the receipt goes' },
      seats: { type: 'integer', title: 'Seats', minimum: 1, maximum: 10 },
      plan: { type: 'string', title: 'Plan', enum: ['basic', 'pro'], enumNames: ['Basic', 'Pro'] },
      region: { type: 'string', oneOf: [{ const: 'eu', title: 'Europe' }, { const: 'us', title: 'United States' }] },
      extras: { type: 'array', title: 'Extras', items: { enum: ['backups', 'support'] } },
      newsletter: { type: 'boolean', title: 'Newsletter', default: true },
      nested: { type: 'object', properties: {} },
    },
    required: ['email', 'seats', 'plan'],
  };

  it('reads a flat schema into fields, leaving other types out', () => {
    expect(elicitationFields(schema).map((f) => [f.name, f.kind, f.label, f.required])).toEqual([
      ['email', 'text', 'Email', true],
      ['seats', 'integer', 'Seats', true],
      ['plan', 'choice', 'Plan', true],
      ['region', 'choice', 'region', false],
      ['extras', 'choices', 'Extras', false],
      ['newsletter', 'boolean', 'Newsletter', false],
    ]);
    const [email, seats, plan, region] = elicitationFields(schema);
    expect(email).toMatchObject({ inputType: 'email', description: 'Where the receipt goes' });
    expect(seats).toMatchObject({ minimum: 1, maximum: 10 });
    expect(plan!.options).toEqual([
      { value: 'basic', label: 'Basic' },
      { value: 'pro', label: 'Pro' },
    ]);
    expect(region!.options!.map((o) => o.label)).toEqual(['Europe', 'United States']);
  });

  it('builds the content once required fields are filled and numbers parse', () => {
    const fields = elicitationFields(schema);
    const values = { email: 'ada@example.com', seats: '3', plan: '', region: '', extras: [], newsletter: false };
    expect(elicitationContent(fields, values)).toBeNull();
    expect(elicitationContent(fields, { ...values, plan: 'pro', seats: '2.5' })).toBeNull();
    expect(elicitationContent(fields, { ...values, plan: 'pro', extras: ['support'] })).toEqual({
      email: 'ada@example.com',
      seats: 3,
      plan: 'pro',
      extras: ['support'],
      newsletter: false,
    });
  });

  it('says which connector asks, and submits the form as accept with its content', async () => {
    render(<InteractionCard sessionId="s" pending={ask({ server: 'billing', message: 'A few details for the invoice.', requestedSchema: schema })} />);
    const card = screen.getByRole('region', { name: 'billing asks for information' });
    expect(card.textContent).toContain('A few details for the invoice.');
    const submit = within(card).getByRole('button', { name: 'Submit' });
    fireEvent.change(within(card).getByRole('textbox', { name: 'Email' }), { target: { value: 'ada@example.com' } });
    fireEvent.change(within(card).getByRole('spinbutton', { name: 'Seats' }), { target: { value: '4' } });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(card).getByRole('radio', { name: 'Pro' }));
    fireEvent.click(within(card).getByRole('checkbox', { name: 'backups' }));
    expect(within(card).getByRole<HTMLInputElement>('checkbox', { name: 'Newsletter' }).checked).toBe(true);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(answers()).toEqual([{ action: 'accept', content: { email: 'ada@example.com', seats: 4, plan: 'pro', extras: ['backups'], newsletter: true } }]),
    );
  });

  it.each([
    ['Decline', 'decline'],
    ['Cancel', 'cancel'],
  ])('%s answers %s', async (label, action) => {
    render(<InteractionCard sessionId="s" pending={ask({ server: 'billing', message: 'Details?', requestedSchema: schema })} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(answers()).toEqual([{ action }]));
  });

  it('shows a link in full and opens it only when asked', async () => {
    render(<InteractionCard sessionId="s" pending={ask({ server: 'github', message: 'Sign in to continue.', url: 'https://github.com/login/device?code=AB12' })} />);
    const card = screen.getByRole('region', { name: 'github asks you to open a link' });
    expect(card.textContent).toContain('https://github.com/login/device?code=AB12');
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Open link' }));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device?code=AB12');
    fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(answers()).toEqual([{ action: 'accept' }]));
  });

  it('won’t open a link that isn’t a web address, and declines', async () => {
    render(<InteractionCard sessionId="s" pending={ask({ server: 'odd', message: 'Open this', url: 'file:///etc/hosts' })} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open link' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(answers()).toEqual([{ action: 'decline' }]));
  });
});
