import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageId } from '@atelier/protocol';
import { ArtifactFrame } from './artifact-frame.tsx';
import { PLACEHOLDERS } from './image-refs.ts';

vi.mock('../../lib/platform.ts', () => ({ artifactRuntimeUrl: () => 'about:blank', blobUrl: (sha: string) => `https://app.test/api/blobs/${sha}` }));

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

  describe('generated images', () => {
    const blob = 'f00dface'.padEnd(64, '0');
    const id = imageId(blob);
    const images = new Map([[id, { id, blob, mime: 'image/png' }]]);
    const html = (ref: string) => `<img src="atelier-image:${ref}">`;

    function withImages(content: string) {
      const view = render(<ArtifactFrame type="html" content={content} theme="light" images={images} />);
      const frame = view.container.querySelector('iframe')!;
      const post = vi.spyOn(frame.contentWindow!, 'postMessage');
      const send = (data: unknown) => act(() => void window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow })));
      return { post, send };
    }

    afterEach(() => vi.unstubAllGlobals());

    it('hands the sandbox the picture as a data URL once it is loaded, not a link it could not follow', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['px'], { type: 'image/png' }) })));
      const { post, send } = withImages(html(id));
      // The frame is ready before the picture is: it is sent what it asked for when both are.
      send({ type: 'ready' });
      expect(post).not.toHaveBeenCalled();
      await waitFor(() => expect(post).toHaveBeenCalledOnce());
      const sent = post.mock.calls[0]![0] as { content: string };
      expect(sent.content).toBe(`<img src="data:image/png;base64,${Buffer.from('px').toString('base64')}">`);
      expect(sent.content).not.toContain('atelier-image');
    });

    it("shows a placeholder for an id that is not this conversation's, and fetches nothing for it", () => {
      const fetching = vi.fn();
      vi.stubGlobal('fetch', fetching);
      const { post, send } = withImages(html('img_deadbeef'));
      send({ type: 'ready' });
      expect(post).toHaveBeenCalledWith({ type: 'render', artifactType: 'html', content: `<img src="${PLACEHOLDERS.unknown}">`, theme: 'light' }, '*');
      expect(fetching).not.toHaveBeenCalled();
    });
  });
});
