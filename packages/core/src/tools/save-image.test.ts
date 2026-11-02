import { describe, expect, it, vi } from 'vitest';
import { imageId, type Message } from '@atelier/protocol';
import type { ToolContext } from './types.ts';
import { createSaveImageTool } from './save-image.ts';

const SHA = 'a'.repeat(64);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const ctx = { sessionId: 's', messageId: 'm', callId: 'c', signal: new AbortController().signal, emit: () => {} } as ToolContext;

function setup() {
  const call = vi.fn(async () => ({ created: true }));
  const checkpoint = vi.fn(async () => {});
  const history: Message[] = [{ id: 't', sessionId: 's', parentId: null, role: 'tool', parts: [{ type: 'tool_result', callId: 'x', content: [{ type: 'image', mime: 'image/png', blob: SHA }] }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0 }];
  const tool = createSaveImageTool({ runner: { call } } as never, { history: async () => history, read: async () => PNG, checkpoint });
  return { tool, call, checkpoint };
}

describe('SaveImage', () => {
  it('writes the image, after a checkpoint for Rewind, and tells the transcript what it saved', async () => {
    const { tool, call, checkpoint } = setup();
    const output = await tool.run({ image: imageId(SHA), file_path: 'public/hero.png' }, ctx);
    expect(checkpoint).toHaveBeenCalledWith(ctx, 'public/hero.png');
    expect(call).toHaveBeenCalledWith('fs.write', expect.objectContaining({ path: 'public/hero.png', encoding: 'base64', mkdirp: true }), expect.anything());
    expect(output.content).toEqual([{ type: 'text', text: 'Saved public/hero.png (1 KB).' }]);
    // For the thumbnail: the model has seen the image, and doesn't get it again.
    expect(output.saved).toEqual({ blob: SHA, mime: 'image/png' });
  });

  it('refuses a name that doesn’t match the image', async () => {
    const { tool, call } = setup();
    const output = await tool.run({ image: imageId(SHA), file_path: 'public/hero.jpg' }, ctx);
    expect(output.isError).toBe(true);
    expect(output.saved).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it('only finds images of this conversation', async () => {
    const { tool } = setup();
    const output = await tool.run({ image: 'img_00000000', file_path: 'x.png' }, ctx);
    expect(output.isError).toBe(true);
    expect(output.content).toEqual([{ type: 'text', text: "There's no image img_00000000 in this conversation." }]);
  });
});
