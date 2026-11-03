import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageId, type GeneratedImageMeta, type Message } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { GeneratedImages, type ImageStep } from '../chat/generated-images.tsx';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { ChangeAreaProvider, sendAreaChange, useChangeArea } from './change-area.tsx';
import { imageIndex } from './session-images.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const meta: GeneratedImageMeta = { id: 'img_1', blob: 'abc123def', mime: 'image/png', width: 1536, height: 1024, prompt: 'A kite above the dunes', ref: 'p/m', modelName: 'Fake Diffusion' };
const step: ImageStep = {
  kind: 'tool',
  key: 'm:0',
  call: { type: 'tool_call', id: 'c1', name: 'GenerateImage', input: { prompt: meta.prompt } },
  result: { type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'Generated.' }], generated: [meta] },
  running: false,
  since: 0,
  output: undefined,
  progress: undefined,
};

beforeEach(() => resetBackend({ 'files.upload': () => ({ id: 'f1', name: 'area-mask.png', mime: 'image/png', size: 3, blob: 'maskblob', kind: 'upload', tokens: null, createdAt: 0 }), 'chat.queue': () => ({ id: 'm', queued: false }) }));
afterEach(() => vi.unstubAllGlobals());

describe('sendAreaChange', () => {
  it('uploads the mask to the conversation, then sends the instruction with both images as one message', async () => {
    await sendAreaChange('s1', { blob: 'imgblob', mime: 'image/webp' }, 'Make the sky purple', new Blob(['png'], { type: 'image/png' }));
    expect(callsTo('files.upload')).toEqual([{ name: 'area-mask.png', mime: 'image/png', dataBase64: Buffer.from('png').toString('base64'), sessionId: 's1' }]);
    expect(callsTo('chat.queue')).toEqual([
      {
        sessionId: 's1',
        // The note to the model is the backend's to write, from these two images: the client sends no text for it.
        parts: [
          { type: 'context', text: '', notice: { kind: 'area', image: { blob: 'imgblob', mime: 'image/webp' }, mask: { blob: 'maskblob', mime: 'image/png' } } },
          { type: 'text', text: 'Make the sky purple' },
        ],
      },
    ]);
  });
});

describe('Change an area on a generated image', () => {
  function show() {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <ChangeAreaProvider sessionId="s1">
            <GeneratedImages step={step} waiting={false} />
          </ChangeAreaProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it('is among the actions on the image, and opens the editor with that picture', async () => {
    show();
    fireEvent.click(screen.getAllByRole('button', { name: 'Change an area' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Change an area' });
    expect(dialog.querySelector('img')!.getAttribute('src')).toContain('abc123def');
    expect(within(dialog).getByRole('textbox', { name: 'What the marked area should become' })).toBeTruthy();
  });

  it('is in the lightbox too, which closes so the editor is the only thing over the page', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /^Open image/ }));
    const lightbox = await screen.findByRole('dialog', { name: 'Image' });
    fireEvent.click(within(lightbox).getByRole('button', { name: 'Change an area' }));
    await screen.findByRole('dialog', { name: 'Change an area' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Image' })).toBeNull());
  });

  it('is not offered where there is no conversation to send it to', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <GeneratedImages step={step} waiting={false} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Change an area' })).toBeNull();
  });

  it('gives a page the means to open it for any image', () => {
    let open: ReturnType<typeof useChangeArea> = null;
    function Probe() {
      open = useChangeArea();
      return null;
    }
    render(
      <ChangeAreaProvider sessionId="s1">
        <Probe />
      </ChangeAreaProvider>,
    );
    expect(open).not.toBeNull();
  });
});

describe('the conversation\'s images', () => {
  const message = (parts: Message['parts']): Message => ({ id: 'm', sessionId: 's', parentId: null, role: 'user', parts, model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0 });

  it('are the ones attached, read by tools and generated, by the ids the model knows them by, and not a marked area\'s mask', () => {
    const index = imageIndex([
      message([
        { type: 'image', mime: 'image/png', blob: 'aaaaaaaa1' },
        { type: 'context', text: '', notice: { kind: 'area', image: { blob: 'aaaaaaaa1', mime: 'image/png' }, mask: { blob: 'bbbbbbbb2', mime: 'image/png' } } },
      ]),
      { ...message([{ type: 'tool_result', callId: 'c', content: [{ type: 'image', mime: 'image/jpeg', blob: 'cccccccc3' }], generated: [{ ...meta, blob: 'dddddddd4' }] }]), role: 'tool' },
    ]);
    expect([...index.keys()].sort()).toEqual([imageId('aaaaaaaa1'), imageId('cccccccc3'), imageId('dddddddd4')].sort());
    expect(index.get(imageId('cccccccc3'))).toEqual({ id: imageId('cccccccc3'), blob: 'cccccccc3', mime: 'image/jpeg' });
    expect(index.has(imageId('bbbbbbbb2'))).toBe(false);
  });
});
