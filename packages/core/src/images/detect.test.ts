import { describe, expect, it } from 'vitest';
import { detectImageServers } from './detect.ts';

type Answers = Record<string, unknown>;

/** A computer where each `port/path` gives this JSON and everything else refuses. */
const computer = (answers: Answers) => async (url: string) => {
  const { port, pathname } = new URL(url);
  if (!(`${port}${pathname}` in answers)) throw new TypeError('fetch failed');
  return new Response(JSON.stringify(answers[`${port}${pathname}`]));
};

const found = async (answers: Answers, skip?: Set<string>) => (await detectImageServers(computer(answers), skip)).map((s) => s.preset);

const CHECKPOINTS = [{ title: 'a [123456]', model_name: 'a' }];

describe('detectImageServers', () => {
  it('finds nothing on a quiet computer', async () => {
    await expect(found({})).resolves.toEqual([]);
  });

  it('finds AUTOMATIC1111', async () => {
    await expect(found({ '7860/sdapi/v1/sd-models': CHECKPOINTS })).resolves.toEqual(['a1111']);
  });

  it('tells Forge apart by the route only it has', async () => {
    await expect(found({ '7860/sdapi/v1/sd-models': CHECKPOINTS, '7860/sdapi/v1/sd-modules': [] })).resolves.toEqual(['forge']);
  });

  it('tells SD.Next apart by its version', async () => {
    await expect(found({ '7860/sdapi/v1/sd-models': CHECKPOINTS, '7860/sdapi/v1/version': { app: 'sd.next', updated: '2026-10-01' } })).resolves.toEqual(['sdnext']);
  });

  it('finds Draw Things, which has no list of checkpoints', async () => {
    await expect(found({ '7860/sdapi/v1/options': { model: 'sd_v1.5_f16.ckpt', steps: 20, guidance_scale: 7, sampler: 'DPM++ 2M Karras' } })).resolves.toEqual(['drawthings']);
  });

  it('does not take AUTOMATIC1111\'s options for Draw Things', async () => {
    await expect(found({ '7860/sdapi/v1/sd-models': CHECKPOINTS, '7860/sdapi/v1/options': { sd_model_checkpoint: 'a [123456]', model: 'x', guidance_scale: 7 } })).resolves.toEqual(['a1111']);
  });

  it('finds KoboldCpp with an image model, and ignores it without one', async () => {
    await expect(found({ '5001/sdapi/v1/sd-models': [{ title: 'dreamshaper' }] })).resolves.toEqual(['koboldcpp']);
    await expect(found({ '5001/sdapi/v1/sd-models': [] })).resolves.toEqual([]);
  });

  it('finds sd-server even with no model loaded, and not LM Studio on the same port', async () => {
    await expect(found({ '1234/sdcpp/v1/models/status': { state: 'empty', recipe: null, models: {}, error: null } })).resolves.toEqual(['sd-server']);
    await expect(found({ '1234/v1/models': { data: [{ id: 'qwen3' }] } })).resolves.toEqual([]);
  });

  it('finds LocalAI by its capability route, and not llama.cpp on the same port', async () => {
    await expect(found({ '8080/v1/models/capabilities': { object: 'list', data: [] } })).resolves.toEqual(['localai']);
    await expect(found({ '8080/v1/models': { data: [{ id: 'gemma' }] } })).resolves.toEqual([]);
  });

  it('finds SwarmUI by the session it gives, and InvokeAI by its version', async () => {
    await expect(found({ '7801/API/GetNewSession': { session_id: 'abc' }, '9090/api/v1/app/version': { version: '6.14.3' } })).resolves.toEqual(['invokeai', 'swarmui']);
  });

  it('does not offer Ollama, whose current versions make no images', async () => {
    await expect(found({ '11434/api/tags': { models: [{ name: 'x/z-image-turbo' }] } })).resolves.toEqual([]);
  });

  it('does not offer a server that is already added', async () => {
    await expect(found({ '7860/sdapi/v1/sd-models': CHECKPOINTS }, new Set(['http://127.0.0.1:7860']))).resolves.toEqual([]);
  });

  it('asks SwarmUI with a POST, which is the only way it answers', async () => {
    const seen: string[] = [];
    await detectImageServers(async (url, init) => {
      seen.push(`${init.method} ${new URL(url).pathname}`);
      throw new TypeError('fetch failed');
    });
    expect(seen).toContain('POST /API/GetNewSession');
  });
});
