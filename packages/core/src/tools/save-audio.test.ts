import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { audioId, type Message } from '@atelier/protocol';
import { createSaveAudioTool } from './save-audio.ts';
import type { ToolContext } from './types.ts';

const SHA = 'a'.repeat(64);
const MP3 = new Uint8Array(readFileSync(new URL('../images/__fixtures__/audio/tone-cbr.mp3', import.meta.url)));
const ctx = { sessionId: 's', messageId: 'm', callId: 'c', signal: new AbortController().signal, emit: () => {} } as ToolContext;

const made = (blob = SHA): Message => ({
  id: 't', sessionId: 's', parentId: null, role: 'tool', model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0,
  parts: [{ type: 'tool_result', callId: 'x', content: [{ type: 'text', text: 'Generated speech' }], generated: [{ id: audioId(blob), blob, mime: 'audio/mpeg', width: 0, height: 0, kind: 'audio', audioKind: 'speech', prompt: 'Hello', ref: 'tts/m', modelName: 'M' }] }],
});

function setup(bytes: Uint8Array = MP3, history: Message[] = [made()]) {
  const call = vi.fn(async () => ({ created: true }));
  const checkpoint = vi.fn(async () => {});
  const tool = createSaveAudioTool({ runner: { call } } as never, { history: async () => history, read: async () => bytes, checkpoint });
  return { tool, call, checkpoint };
}

describe('SaveAudio', () => {
  it('writes the sound after a checkpoint for Rewind, and tells the transcript what it saved', async () => {
    const { tool, call, checkpoint } = setup();
    const output = await tool.run({ audio: audioId(SHA), file_path: 'public/hello.mp3' }, ctx);
    expect(checkpoint).toHaveBeenCalledWith(ctx, 'public/hello.mp3');
    expect(call).toHaveBeenCalledWith('fs.write', expect.objectContaining({ path: 'public/hello.mp3', encoding: 'base64', mkdirp: true }), expect.anything());
    expect(output.content[0]).toMatchObject({ type: 'text', text: 'Saved public/hello.mp3 (6 KB).' });
    expect(output.saved).toEqual({ blob: SHA, mime: 'audio/mpeg' });
  });

  it('refuses bytes that are not a sound, so it can’t write any file through a fake one', async () => {
    const { tool, call } = setup(new TextEncoder().encode('#!/bin/sh\nrm -rf /\n'));
    expect((await tool.run({ audio: audioId(SHA), file_path: 'deploy/run.mp3' }, ctx)).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a name that doesn’t match the format', async () => {
    const { tool, call } = setup();
    const output = await tool.run({ audio: audioId(SHA), file_path: 'public/hello.wav' }, ctx);
    expect(output.content).toEqual([{ type: 'text', text: 'This sound is an MP3 file: save it with a .mp3 name, or convert it afterwards.' }]);
    expect(call).not.toHaveBeenCalled();
  });

  it('only finds sounds this conversation made, and sends pictures and clips elsewhere', async () => {
    const { tool } = setup();
    expect((await tool.run({ audio: 'aud_00000000', file_path: 'x.mp3' }, ctx)).content).toEqual([{ type: 'text', text: "There's no sound aud_00000000 in this conversation." }]);
    expect((await tool.run({ audio: 'vid_ab12cd34', file_path: 'x.mp3' }, ctx)).content).toEqual([{ type: 'text', text: '"vid_ab12cd34" isn\'t a sound id. For a picture use SaveImage, for a video SaveVideo.' }]);
  });
});
