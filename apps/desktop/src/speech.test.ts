import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MacSpeech, type SpeechUpdate } from './speech.ts';

/** A stand-in for atelier-speech: answers start as told by its language, echoes audio lengths as words, stops with "done". */
function fakeHelper(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'atelier-speech-')), 'atelier-speech');
  writeFileSync(
    file,
    `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let words = [];
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'start') {
    if (m.language === 'xx') { out({ type: 'error', code: 'unsupported', message: 'The Mac’s speech recognition doesn’t know this language.' }); process.exit(1); }
    out({ type: 'preparing', fraction: 0.5 });
    out({ type: 'ready', locale: m.language === 'de' ? 'de_DE' : 'en_US' });
  } else if (m.type === 'audio') {
    words.push(String(Buffer.from(m.pcm, 'base64').length));
    out({ type: 'text', text: words.join(' ') });
    if (words.length === 2 && process.env.FAKE_CRASH) process.exit(3);
  } else if (m.type === 'stop') {
    out({ type: 'final', text: words.join(' ') + ' done' });
    process.exit(0);
  }
});
`,
  );
  chmodSync(file, 0o755);
  return file;
}

const unix = process.platform === 'win32' ? describe.skip : describe;

unix('the Mac’s own dictation, through main', () => {
  it('starts the helper, passes the sound on, sends the words to the window and stops with the last of them', async () => {
    const updates: { owner: number; update: SpeechUpdate }[] = [];
    const speech = new MacSpeech(fakeHelper(), (owner, update) => updates.push({ owner, update }));
    const { id, locale } = await speech.start(3, 'de');
    expect(locale).toBe('de_DE');
    expect(updates[0]).toEqual({ owner: 3, update: { id, preparing: 0.5 } });
    speech.audio(3, id, new Uint8Array(3200));
    // Another window's sound never reaches it.
    speech.audio(4, id, new Uint8Array(10));
    await new Promise((r) => setTimeout(r, 200));
    expect(updates.at(-1)).toEqual({ owner: 3, update: { id, text: '3200' } });
    expect(await speech.stop(3, id)).toBe('3200 done');
  });

  it('tells the window when the helper dies, and keeps what it heard for the stop', async () => {
    process.env.FAKE_CRASH = '1';
    const updates: SpeechUpdate[] = [];
    const speech = new MacSpeech(fakeHelper(), (_owner, update) => updates.push(update));
    const { id } = await speech.start(3, 'en');
    speech.audio(3, id, new Uint8Array(100));
    speech.audio(3, id, new Uint8Array(200));
    await new Promise((r) => setTimeout(r, 300));
    delete process.env.FAKE_CRASH;
    expect(updates.at(-1)).toEqual({ id, error: 'The Mac’s speech recognition stopped unexpectedly.', code: 'failed' });
    expect(await speech.stop(3, id)).toBe('100 200');
  });

  it('says why it couldn’t start, with the helper’s code', async () => {
    const speech = new MacSpeech(fakeHelper(), () => {});
    await expect(speech.start(3, 'xx')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('isn’t available without its helper', async () => {
    expect(await new MacSpeech(null, () => {}).available()).toEqual({ available: false, locales: [] });
    await expect(new MacSpeech(null, () => {}).start(1, 'en')).rejects.toMatchObject({ code: 'unavailable' });
  });
});
