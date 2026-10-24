import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyLending, changeLending, readLending } from './lending.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-lending-'));
  file = join(dir, 'lending.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('what this computer lends each server', () => {
  it('lends nothing beyond trusted folders until the person allows it, per server', async () => {
    expect(await readLending(file, 'https://a.example')).toEqual({ scratch: false, ssh: [] });
    await changeLending(file, 'https://a.example', (l) => applyLending(l, { kind: 'scratch', allowed: true }));
    await changeLending(file, 'https://a.example', (l) => applyLending(l, { kind: 'ssh', host: 'box', allowed: true }));
    await changeLending(file, 'https://a.example', (l) => applyLending(l, { kind: 'ssh', host: 'box', allowed: true }));
    expect(await readLending(file, 'https://a.example')).toEqual({ scratch: true, ssh: ['box'] });
    // Another server gets nothing from it.
    expect(await readLending(file, 'https://b.example')).toEqual({ scratch: false, ssh: [] });
    await changeLending(file, 'https://a.example', (l) => applyLending(l, { kind: 'ssh', host: 'box', allowed: false }));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'https://a.example': { scratch: true, ssh: [] } });
  });

  it('reads a damaged file as nothing allowed', async () => {
    writeFileSync(file, '{"https://a.example": {"scratch": "yes", "ssh": [1]}}');
    expect(await readLending(file, 'https://a.example')).toEqual({ scratch: false, ssh: [] });
    writeFileSync(file, 'not json');
    expect(await readLending(file, 'https://a.example')).toEqual({ scratch: false, ssh: [] });
  });

  it('writes one change at a time', async () => {
    await Promise.all(['a', 'b', 'c'].map((host) => changeLending(file, 'https://a.example', (l) => applyLending(l, { kind: 'ssh', host, allowed: true }))));
    expect((await readLending(file, 'https://a.example')).ssh.sort()).toEqual(['a', 'b', 'c']);
  });
});
