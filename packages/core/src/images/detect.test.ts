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
    // One LocalAI is two providers here: its pictures and its sound.
    await expect(found({ '8080/v1/models/capabilities': { object: 'list', data: [] } })).resolves.toEqual(['localai', 'localai-speech']);
    await expect(found({ '8080/v1/models': { data: [{ id: 'gemma' }] } })).resolves.toEqual([]);
  });

  it('finds SwarmUI by the session it gives, and InvokeAI by its version', async () => {
    await expect(found({ '7801/API/GetNewSession': { session_id: 'abc' }, '9090/api/v1/app/version': { version: '6.14.3' } })).resolves.toEqual(['invokeai', 'swarmui']);
  });

  it('does not offer Ollama, whose current versions make no images', async () => {
    await expect(found({ '11434/api/tags': { models: [{ name: 'x/z-image-turbo' }] } })).resolves.toEqual([]);
  });

  it('finds the sound servers by a reply only each gives', async () => {
    await expect(found({ '8880/v1/audio/voices': { voices: [{ id: 'af_heart', name: 'af_heart' }], default_voice: 'af_heart' } })).resolves.toEqual(['kokoro']);
    await expect(found({ '8004/v1/audio/voices': { status: 'ok', voices: ['Emily.wav'] } })).resolves.toEqual(['chatterbox']);
    await expect(found({ '8000/v1/registry': { data: [{ id: 'speaches-ai/Kokoro-82M-v1.0-ONNX' }] } })).resolves.toEqual(['speaches']);
    await expect(found({ '8001/v1/models': { data: { models: ['acestep-v15-turbo'] }, code: 200, error: null } })).resolves.toEqual(['acestep']);
    await expect(found({ '8080/v1/health': { status: 'ok' } })).resolves.toEqual(['fish-speech']);
  });

  it('finds KoboldCpp speaking only when it says it has a speech model', async () => {
    await expect(found({ '5001/api/extra/version': { result: 'KoboldCpp', version: '1.124.2', tts: true } })).resolves.toEqual(['koboldcpp-speech']);
    await expect(found({ '5001/api/extra/version': { result: 'KoboldCpp', version: '1.124.2', tts: false } })).resolves.toEqual([]);
  });

  it('offers Ollama for speech once it has a speech model', async () => {
    await expect(found({ '11434/api/tags': { models: [{ name: 'phonon:latest' }] } })).resolves.toEqual(['ollama-speech']);
    await expect(found({ '11434/api/tags': { models: [{ name: 'qwen3:8b' }] } })).resolves.toEqual([]);
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
