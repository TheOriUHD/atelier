import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { videoId, type Message } from '@atelier/protocol';
import { createSaveVideoTool } from './save-video.ts';
import type { ToolContext } from './types.ts';

const SHA = 'a'.repeat(64);
const MP4 = new Uint8Array(readFileSync(new URL('../images/__fixtures__/tiny.mp4', import.meta.url)));
const ctx = { sessionId: 's', messageId: 'm', callId: 'c', signal: new AbortController().signal, emit: () => {} } as ToolContext;

const made = (blob = SHA): Message => ({
  id: 't', sessionId: 's', parentId: null, role: 'tool', model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0,
  parts: [{ type: 'tool_result', callId: 'x', content: [{ type: 'text', text: 'Generated a video' }], generated: [{ id: videoId(blob), blob, mime: 'video/mp4', width: 160, height: 90, kind: 'video', prompt: 'p', ref: 'v/m', modelName: 'M' }] }],
});

function setup(bytes: Uint8Array = MP4, history: Message[] = [made()]) {
  const call = vi.fn(async () => ({ created: true }));
  const checkpoint = vi.fn(async () => {});
  const tool = createSaveVideoTool({ runner: { call } } as never, { history: async () => history, read: async () => bytes, checkpoint });
  return { tool, call, checkpoint };
}

describe('SaveVideo', () => {
  it('writes the video after a checkpoint for Rewind, and tells the transcript what it saved', async () => {
    const { tool, call, checkpoint } = setup();
    const output = await tool.run({ video: videoId(SHA), file_path: 'public/intro.mp4' }, ctx);
    expect(checkpoint).toHaveBeenCalledWith(ctx, 'public/intro.mp4');
    expect(call).toHaveBeenCalledWith('fs.write', expect.objectContaining({ path: 'public/intro.mp4', encoding: 'base64', mkdirp: true }), expect.anything());
    expect(output.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^Saved public\/intro\.mp4 \(0\.0 MB\)\.$/) });
    expect(output.saved).toEqual({ blob: SHA, mime: 'video/mp4' });
  });

  it('refuses bytes that are not a video, so it can’t write any file through a fake one', async () => {
    const { tool, call } = setup(new TextEncoder().encode('#!/bin/sh\nrm -rf /\n'));
    const output = await tool.run({ video: videoId(SHA), file_path: 'deploy/run.mp4' }, ctx);
    expect(output.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a name that doesn’t match the container', async () => {
    const { tool, call } = setup();
    const output = await tool.run({ video: videoId(SHA), file_path: 'public/intro.webm' }, ctx);
    expect(output.isError).toBe(true);
    expect(output.content).toEqual([{ type: 'text', text: 'This video is an MP4: save it with a .mp4 name, or convert it afterwards.' }]);
    expect(call).not.toHaveBeenCalled();
  });

  it('only finds videos this conversation made, and sends pictures to SaveImage', async () => {
    const { tool } = setup();
    expect((await tool.run({ video: 'vid_00000000', file_path: 'x.mp4' }, ctx)).content).toEqual([{ type: 'text', text: "There's no video vid_00000000 in this conversation." }]);
    expect((await tool.run({ video: 'img_ab12cd34', file_path: 'x.mp4' }, ctx)).content).toEqual([{ type: 'text', text: '"img_ab12cd34" isn\'t a video id. For a picture, use SaveImage.' }]);
  });
});
