import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageId, type Message, type ToolCallPart, type ToolResultPart } from '@atelier/protocol';
import { SessionImagesProvider } from '../images/session-images.tsx';
import { InlineVisual } from './inline-visual.tsx';

vi.mock('../../lib/platform.ts', () => ({ artifactRuntimeUrl: () => 'file:///runtime/index.html', blobUrl: (sha: string) => `https://app.test/api/blobs/${sha}` }));

const BLOB = 'beefbeef'.padEnd(64, '1');
const OTHER = imageId('cafecafe'.padEnd(64, '2'));
const message: Message = {
  id: 'm',
  sessionId: 's',
  parentId: null,
  role: 'tool',
  parts: [{ type: 'tool_result', callId: 'x', content: [{ type: 'image', mime: 'image/png', blob: BLOB }] }],
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: 0,
};
const call = (html: string): ToolCallPart => ({ type: 'tool_call', id: 'v', name: 'inline_visual', input: { title: 'Poster', description: 'A poster', html } });
const done: ToolResultPart = { type: 'tool_result', callId: 'v', content: [{ type: 'text', text: 'Inline visual shown.' }] };

afterEach(() => vi.unstubAllGlobals());

describe('InlineVisual with generated images', () => {
  it("puts the conversation's picture into the frame as a data URL, and an id from elsewhere as a placeholder", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['px'], { type: 'image/png' }) })));
    const html = `<img src="atelier-image:${imageId(BLOB)}"><img src="atelier-image:${OTHER}">`;
    const view = render(
      <SessionImagesProvider messages={[message]}>
        <InlineVisual call={call(html)} result={done} partialInput={undefined} running={false} />
      </SessionImagesProvider>,
    );
    const frame = view.container.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => void window.dispatchEvent(new MessageEvent('message', { data: { type: 'inline:ready' }, source: frame.contentWindow })));
    await waitFor(() => {
      const sent = post.mock.calls.map((c) => c[0] as { type: string; html?: string }).filter((m) => m.type === 'inline:render').at(-1);
      expect(sent?.html).toContain(`data:image/png;base64,${Buffer.from('px').toString('base64')}`);
    });
    const sent = post.mock.calls.map((c) => c[0] as { type: string; html?: string }).filter((m) => m.type === 'inline:render').at(-1)!;
    expect(sent.html).not.toContain('atelier-image');
    expect(sent.html).toContain('data:image/svg+xml');
    // Only the conversation's own picture was ever fetched.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
