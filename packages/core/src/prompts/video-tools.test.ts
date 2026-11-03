import { describe, expect, it } from 'vitest';
import { assemble, CASES } from './__fixtures__/prompt-cases.ts';

const names = async (name: keyof typeof CASES | string, extra: object = {}) => (await assemble({ ...CASES[name]!, ...extra })).tools.map((t) => t.name);

describe('the video tools in a session’s request', () => {
  it('are offered only with a video model, and SaveVideo only with a folder', async () => {
    expect(await names('chat.full')).not.toContain('GenerateVideo');
    expect(await names('code.full')).not.toContain('GenerateVideo');
    expect(await names('code.full')).not.toContain('SaveVideo');
    expect(await names('chat.full.videos')).toContain('GenerateVideo');
    expect(await names('chat.full.videos')).not.toContain('SaveVideo');
    expect(await names('code.full.videos')).toEqual(expect.arrayContaining(['GenerateVideo', 'SaveVideo']));
  });

  it('are never given to a sub-agent', async () => {
    expect(await names('code.full.subagent', { videos: true })).not.toEqual(expect.arrayContaining(['GenerateVideo']));
  });

  it('leave a session without a video model byte for byte as it was', async () => {
    const plain = await assemble(CASES['code.full']!);
    const withImages = await assemble(CASES['code.full.images']!);
    expect(JSON.stringify(plain.tools)).not.toContain('Video');
    expect(JSON.stringify(withImages.tools)).not.toContain('Video');
    expect(plain.system.map((b) => b.text).join('\n')).not.toContain('GenerateVideo');
  });

  it('tell the model about the models in a note, not in the tool description', async () => {
    const a = await assemble(CASES['chat.full.videos']!);
    expect(JSON.stringify(a.tools)).not.toContain('fal/kling');
    expect(a.notes.join('\n')).toContain('Video models you can use with GenerateVideo');
    expect(a.notes.join('\n')).toContain('fal/kling/v4/text-to-video');
  });

  it('give a compact model a shorter schema than a full one', async () => {
    const full = (await assemble(CASES['code.full.videos']!)).tools.find((t) => t.name === 'GenerateVideo')!;
    const compact = (await assemble(CASES['code.compact.videos']!)).tools.find((t) => t.name === 'GenerateVideo')!;
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 2);
    expect(Object.keys((compact.inputSchema as { properties: object }).properties)).toEqual(['prompt', 'aspect_ratio', 'seconds', 'first_frame', 'model']);
  });
});
