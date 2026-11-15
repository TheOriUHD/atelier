import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { DictationUpdate } from '@atelier/protocol';
import { DictationError, DictationService } from '../service.ts';
import { dictationChoices } from '../sources.ts';
import { BuiltinSpeech } from './builtin.ts';
import { untarPackage } from './install.ts';
import { SPEECH_MODEL, speechDownloadBytes } from './manifest.ts';

/** A tarball with these entries (name → body), as npm packs them. */
function tgz(entries: Record<string, string>, type = '0'): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(entries)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write(Buffer.byteLength(body).toString(8).padStart(11, '0'), 124);
    header.write(type, 156);
    blocks.push(header, Buffer.from(body), Buffer.alloc((512 - (Buffer.byteLength(body) % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('the speech engine’s package', () => {
  it('unpacks the flat files of package/, and nothing that would land elsewhere', () => {
    const files = untarPackage(tgz({ 'package/sherpa-onnx.node': 'addon', 'package/libonnxruntime.so': 'lib', 'package/../evil.sh': 'x', 'package/sub/inner.txt': 'y', 'other/file': 'z' }));
    expect([...files.keys()].sort()).toEqual(['libonnxruntime.so', 'sherpa-onnx.node']);
    expect(new TextDecoder().decode(files.get('sherpa-onnx.node'))).toBe('addon');
  });

  it('skips links and folders', () => {
    expect(untarPackage(tgz({ 'package/sherpa-onnx.node': '/etc/passwd' }, '2')).size).toBe(0);
  });
});

describe('Atelier’s own speech model', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'atelier-speech-test-'));

  it('is missing until fetched, and says how big the download is', async () => {
    const own = new BuiltinSpeech({ dir: dir(), platform: 'linux-x64' });
    await new Promise((r) => setTimeout(r, 20));
    expect(own.state()).toEqual({ state: 'missing', bytes: speechDownloadBytes('linux-x64') });
    expect(speechDownloadBytes('linux-x64')).toBeGreaterThan(SPEECH_MODEL.files[0].bytes);
  });

  it('is unsupported where the engine has no build', () => {
    expect(new BuiltinSpeech({ dir: dir(), platform: 'freebsd-x64' }).state()).toEqual({ state: 'unsupported' });
  });

  it('says why a download failed, and keeps nothing half-fetched', async () => {
    const states: string[] = [];
    const own = new BuiltinSpeech({ dir: dir(), platform: 'linux-x64', fetch: async () => new Response('nope', { status: 503 }) });
    own.on('state', (s) => states.push(s.state));
    await expect(own.prepare()).rejects.toThrow(/answered 503/);
    expect(states).toEqual(['downloading', 'failed']);
    expect(own.state()).toMatchObject({ state: 'failed', error: expect.stringMatching(/503/) });
  });

  it('keeps nothing of a download that broke off midway, and says why', async () => {
    const folder = dir();
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1000));
            controller.error(new Error('connection reset'));
          },
        }),
      );
    const own = new BuiltinSpeech({ dir: folder, platform: 'linux-x64', fetch: async () => broken() });
    await expect(own.prepare()).rejects.toThrow(/connection reset/);
    expect(readdirSync(folder).filter((f) => f.endsWith('.part') || f.endsWith('.tgz'))).toEqual([]);
  });

  it('refuses a download whose checksum is wrong', async () => {
    const own = new BuiltinSpeech({ dir: dir(), platform: 'linux-x64', fetch: async () => new Response('not the engine') });
    await expect(own.prepare()).rejects.toThrow(/checksum is wrong/);
  });
});

describe('dictation with the own model', () => {
  it('comes first among the services, ahead of providers', () => {
    const all = dictationChoices([{ id: 'mis', type: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai', headers: {}, enabled: true }], [], { label: 'Nemotron 3.5 ASR', where: 'Atelier, on this server' });
    expect(all.map((c) => c.source.id)).toEqual(['builtin', 'text:mis:voxtral-mini-transcribe-realtime-3']);
    expect(all[0]!.source).toEqual({ id: 'builtin', label: 'Nemotron 3.5 ASR', provider: 'Atelier, on this server', live: true });
  });

  it('starts fetching the model when someone dictates before it is here, and says so', async () => {
    let prepared = 0;
    const own = { label: 'Nemotron 3.5 ASR', state: () => ({ state: 'missing' as const, bytes: 1 }), prepare: async () => void prepared++ } as unknown as BuiltinSpeech;
    const service = new DictationService<string>({ settings: () => ({ enabled: true, text: [], media: [] }), credentials: async () => ({ headers: {} }), fetch: async () => new Response(), builtin: own });
    expect(service.status(true)).toMatchObject({ source: { id: 'builtin' }, builtin: { state: 'missing', bytes: 1 } });
    const error = await service.start('w', 'u', { language: 'auto' }, () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DictationError);
    expect((error as DictationError).code).toBe('preparing');
    expect(prepared).toBe(1);
  });

  it('gives a language it doesn’t know to a provider that may, unless an admin chose the model', async () => {
    const own = { label: 'Nemotron 3.5 ASR', state: () => ({ state: 'ready' as const }), prepare: async () => undefined, open: async () => { throw new Error('not the model'); } } as unknown as BuiltinSpeech;
    const mistral = { id: 'mis', type: 'mistral' as const, name: 'Mistral', baseUrl: 'https://api.mistral.ai', headers: {}, enabled: true };
    let connected = '';
    const service = (source?: string) =>
      new DictationService<string>({
        settings: () => ({ enabled: true, ...(source ? { source } : {}), text: [mistral], media: [] }),
        credentials: async () => ({ apiKey: 'k', headers: {} }),
        fetch: async () => new Response(),
        connect: async (url) => {
          connected = url;
          throw new Error('stop here');
        },
        builtin: own,
      });
    // Icelandic: not one of the model's languages, so Mistral is asked.
    await expect(service().start('w', 'u', { language: 'is' }, () => {})).rejects.toThrow();
    expect(connected).toContain('api.mistral.ai');
    connected = '';
    await expect(service('builtin').start('w', 'u', { language: 'is' }, () => {})).rejects.toThrow(/not the model/);
    expect(connected).toBe('');
  });

  it('downloads it when an admin asks, whatever dictation uses now', async () => {
    let prepared = 0;
    const own = { label: 'Nemotron 3.5 ASR', state: () => ({ state: 'missing' as const, bytes: 1 }), prepare: async () => void prepared++ } as unknown as BuiltinSpeech;
    const mistral = { id: 'mis', type: 'mistral' as const, name: 'Mistral', baseUrl: 'https://api.mistral.ai', headers: {}, enabled: true };
    const service = new DictationService<string>({ settings: () => ({ enabled: true, source: 'text:mis:voxtral-mini-transcribe-realtime-3', text: [mistral], media: [] }), credentials: async () => ({ headers: {} }), fetch: async () => new Response(), builtin: own });
    service.prepare(false);
    expect(prepared).toBe(0);
    service.prepare(true);
    expect(prepared).toBe(1);
  });

  it('dictates with it once it is here', async () => {
    const updates: DictationUpdate[] = [];
    const own = {
      label: 'Nemotron 3.5 ASR',
      state: () => ({ state: 'ready' as const }),
      prepare: async () => undefined,
      open: async (language: string | null, events: { onText(t: string): void }) => ({
        write: () => events.onText(`heard (${language})`),
        finish: async () => 'Final words.',
        abort: () => {},
      }),
    } as unknown as BuiltinSpeech;
    const service = new DictationService<string>({ settings: () => ({ enabled: true, text: [], media: [] }), credentials: async () => ({ headers: {} }), fetch: async () => new Response(), builtin: own });
    const { id, live } = await service.start('w', 'u', { language: 'de' }, (u) => updates.push(u));
    expect(live).toBe(true);
    service.audio('w', id, 0, new Uint8Array(3200));
    expect(updates.at(-1)).toEqual({ id, text: 'heard (de)' });
    expect(await service.stop('w', id)).toEqual({ text: 'Final words.' });
  });
});
