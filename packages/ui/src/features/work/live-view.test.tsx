import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message, Part } from '@atelier/protocol';
import { LiveView, liveScreen, screenTitle, stepText } from './live-view.tsx';

let n = 0;
const message = (role: Message['role'], parts: Part[]): Message =>
  ({ id: `m${++n}`, role, parts, parentId: null, createdAt: n, kind: 'normal' }) as unknown as Message;
const call = (id: string, name: string, input: object): Part => ({ type: 'tool_call', id, name, input }) as Part;
const shot = (callId: string, text: string, blob: string, isError = false): Part =>
  ({ type: 'tool_result', callId, content: [{ type: 'text', text }, { type: 'image', mime: 'image/jpeg', blob }], ...(isError ? { isError } : {}) }) as Part;
const done = (callId: string, text = '1. key: done'): Part => ({ type: 'tool_result', callId, content: [{ type: 'text', text }] }) as Part;
const said = (text: string): Part => ({ type: 'text', text });

const CALC = 'Opened Calculator. Screenshot of Calculator’s window “Calculator”, 1280×775 pixels. Only this window.';

afterEach(() => sessionStorage.clear());

describe('screenTitle', () => {
  it('names the app of a window, the page of a tab, and the screen in Full control', () => {
    expect(screenTitle('OpenApp', CALC)).toBe('Calculator');
    expect(screenTitle('Screenshot', 'Screenshot of Main, 1280×800 pixels. The screen as the person sees it.')).toBe('Your screen');
    expect(screenTitle('Browser', 'Tab 4 · Amazon.de: Cart · https://www.amazon.de/cart · 1280×900 CSS pixels')).toBe('Amazon.de: Cart');
    expect(screenTitle('ComputerAction', '1. Clear: done 2. screenshot: done')).toBeNull();
  });
});

describe('stepText', () => {
  it('says what a step does: the first summary of a batch, or what the tool does', () => {
    expect(stepText('ComputerAction', { actions: [{ action: 'key', text: '7' }, { action: 'left_click', element: 3, summary: 'Multiplies' }] })).toBe('Multiplies');
    expect(stepText('ComputerAction', { actions: [{ action: 'key', text: '7' }] })).toBe('Working in the app');
    expect(stepText('OpenApp', { app: 'Numbers' })).toBe('Opening Numbers');
    expect(stepText('Browser', { action: 'type', tab: '4', text: 'usb c cable' })).toBe('Typing in the page');
    expect(stepText('Read', { file_path: '/x' })).toBeNull();
  });
});

describe('liveScreen', () => {
  it('shows the latest picture of the run with its app, and the step running now', () => {
    const messages = [
      message('user', [said('Do five sums in Calculator')]),
      message('assistant', [call('a', 'OpenApp', { app: 'Calculator' })]),
      message('tool', [shot('a', CALC, 'first')]),
      message('assistant', [call('b', 'ComputerAction', { actions: [{ action: 'key', text: '2' }, { action: 'screenshot' }] })]),
      message('tool', [shot('b', '1. key: done 2. screenshot: done', 'second')]),
      message('assistant', [call('c', 'ComputerAction', { actions: [{ action: 'left_click', element: 10, summary: 'Clears the calculator' }] })]),
    ];
    expect(liveScreen(messages)).toEqual({ blob: 'second', mime: 'image/jpeg', title: 'Calculator', doing: 'Clears the calculator' });
    // Between steps nothing is running.
    expect(liveScreen([...messages, message('tool', [done('c')])])?.doing).toBeNull();
  });

  it('is nothing without a picture, and leaves out failed steps and other tools’ images', () => {
    expect(liveScreen([message('assistant', [call('a', 'Read', { file_path: '/a.png' })]), message('tool', [shot('a', 'an image', 'file')])])).toBeNull();
    const failed = [message('assistant', [call('a', 'Screenshot', { app: 'Numbers' })]), message('tool', [shot('a', 'Screenshot of Numbers’s window “x”, 10×10 pixels.', 'broken', true)])];
    expect(liveScreen(failed)).toBeNull();
  });
});

describe('LiveView', () => {
  const run = [
    message('user', [said('Do five sums in Calculator')]),
    message('assistant', [call('a', 'OpenApp', { app: 'Calculator' })]),
    message('tool', [shot('a', CALC, 'first')]),
    message('assistant', [call('b', 'ComputerAction', { actions: [{ action: 'left_click', element: 10, summary: 'Clears the calculator' }] })]),
  ];

  it('shows what it sees while the task runs, and nothing once it ended', () => {
    const { rerender } = render(<LiveView sessionId="s1" messages={run} running />);
    const view = screen.getByRole('region', { name: 'Live view' });
    expect(within(view).getByRole('heading').textContent).toContain('Calculator');
    expect(within(view).getByText('Clears the calculator')).toBeTruthy();
    expect(view.querySelector('img')?.getAttribute('src')).toContain('first');
    rerender(<LiveView sessionId="s1" messages={run} running={false} />);
    expect(screen.queryByRole('region', { name: 'Live view' })).toBeNull();
  });

  it('hides on ✕ while the task goes on, and comes back on request', () => {
    const { unmount } = render(<LiveView sessionId="s1" messages={run} running />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide (the task goes on)' }));
    expect(screen.queryByRole('region', { name: 'Live view' })).toBeNull();
    // It stays hidden for this session when the page opens again.
    unmount();
    render(<LiveView sessionId="s1" messages={run} running />);
    fireEvent.click(screen.getByRole('button', { name: 'Show what it sees' }));
    expect(screen.getByRole('region', { name: 'Live view' })).toBeTruthy();
  });

  it('offers no pop-out outside the desktop app', () => {
    render(<LiveView sessionId="s1" messages={run} running />);
    expect(screen.queryByRole('button', { name: 'Pop out' })).toBeNull();
  });
});
