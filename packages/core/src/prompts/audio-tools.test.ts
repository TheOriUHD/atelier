import { describe, expect, it } from 'vitest';
import { assemble, CASES } from './__fixtures__/prompt-cases.ts';

const names = async (name: keyof typeof CASES | string, extra: object = {}) => (await assemble({ ...CASES[name]!, ...extra })).tools.map((t) => t.name);

describe('the sound tools in a session’s request', () => {
  it('are offered only with a sound model, and SaveAudio only with a folder', async () => {
    expect(await names('chat.full')).not.toContain('GenerateAudio');
    expect(await names('code.full')).not.toContain('SaveAudio');
    expect(await names('chat.full.audio')).toContain('GenerateAudio');
    expect(await names('chat.full.audio')).not.toContain('SaveAudio');
    expect(await names('code.full.audio')).toEqual(expect.arrayContaining(['GenerateAudio', 'SaveAudio']));
  });

  it('are never given to a sub-agent', async () => {
    expect(await names('code.full.subagent', { audio: true })).not.toEqual(expect.arrayContaining(['GenerateAudio']));
  });

  it('leave a session without a sound model byte for byte as it was', async () => {
    const plain = await assemble(CASES['code.full']!);
    const withVideos = await assemble(CASES['code.full.videos']!);
    expect(JSON.stringify(plain.tools)).not.toContain('GenerateAudio');
    expect(JSON.stringify(withVideos.tools)).not.toContain('SaveAudio');
    expect(plain.system.map((b) => b.text).join('\n')).not.toContain('GenerateAudio');
  });

  it('tell the model about the models and their voices in a note, not in the tool description', async () => {
    const a = await assemble(CASES['chat.full.audio']!);
    expect(JSON.stringify(a.tools)).not.toContain('af_heart');
    expect(a.notes.join('\n')).toContain('Sound models you can use with GenerateAudio');
    expect(a.notes.join('\n')).toContain('af_heart (Heart: warm, American) [usual]');
    expect(a.system.map((b) => b.text).join('\n')).toContain('# Making sounds');
  });

  it('give a compact model a shorter schema than a full one', async () => {
    const full = (await assemble(CASES['code.full.audio']!)).tools.find((t) => t.name === 'GenerateAudio')!;
    const compact = (await assemble(CASES['code.compact.audio']!)).tools.find((t) => t.name === 'GenerateAudio')!;
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 2);
    expect(Object.keys((compact.inputSchema as { properties: object }).properties)).toEqual(['kind', 'text', 'voice', 'prompt', 'seconds', 'model']);
  });
});
