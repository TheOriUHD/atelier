import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactFrame } from './artifact-frame.tsx';

vi.mock('../../lib/platform.ts', () => ({ artifactRuntimeUrl: () => 'about:blank' }));

function setup() {
  const view = render(<ArtifactFrame type="html" content="<h1>Hi</h1>" theme="dark" />);
  const frame = view.container.querySelector('iframe')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const send = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
    act(() => void window.dispatchEvent(new MessageEvent('message', { data, source })));
  return { frame, post, send };
}

describe('ArtifactFrame', () => {
  it('isolates the runtime: scripts only, never same-origin', () => {
    const { frame } = setup();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe('about:blank');
  });

  it('sends the artifact once the runtime is ready, then shows it', () => {
    const { frame, post, send } = setup();
    expect(frame.className).toContain('invisible');
    send({ type: 'ready' });
    expect(post).toHaveBeenCalledWith(
      { type: 'render', artifactType: 'html', content: '<h1>Hi</h1>', theme: 'dark' },
      '*',
    );
    send({ type: 'rendered' });
    expect(frame.className).not.toContain('invisible');
  });

  it('shows runtime errors inline', () => {
    const { send } = setup();
    send({ type: 'error', message: 'x is not defined' });
    expect(screen.getByRole('alert').textContent).toContain('x is not defined');
  });

  it('ignores messages that do not come from its frame', () => {
    const { frame, post, send } = setup();
    const other = document.createElement('iframe');
    document.body.append(other);
    send({ type: 'ready' }, window);
    send({ type: 'ready' }, other.contentWindow);
    send({ type: 'error', message: 'spoofed' }, null);
    send({ type: 'rendered' }, window);
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(frame.className).toContain('invisible');
    other.remove();
  });
});
