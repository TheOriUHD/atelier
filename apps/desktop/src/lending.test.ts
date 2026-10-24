import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_LENDING } from '@atelier/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyLending, changeLending, connectorFingerprint, readLending } from './lending.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-lending-'));
  file = join(dir, 'lending.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('what this computer lends each server', () => {
  it('lends nothing beyond trusted folders until the person allows it, per server', async () => {
    expect(await readLending(file, 'https://a.example')).toEqual({ ...NO_LENDING, scratch: false, ssh: [] });
    await changeLending(file, 'https://a.example', (l) => applyLending(l, { kind: 'scratch', allowed: true }));
    await changeLending(file, 'https://a.example', (l) => applyLending(l, { kind: 'ssh', host: 'box', allowed: true }));
    await changeLending(file, 'https://a.example', (l) => applyLending(l, { kind: 'ssh', host: 'box', allowed: true }));
    expect(await readLending(file, 'https://a.example')).toEqual({ ...NO_LENDING, scratch: true, ssh: ['box'] });
    // Another server gets nothing from it.
    expect(await readLending(file, 'https://b.example')).toEqual({ ...NO_LENDING, scratch: false, ssh: [] });
    await changeLending(file, 'https://a.example', (l) => applyLending(l, { kind: 'ssh', host: 'box', allowed: false }));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'https://a.example': { ...NO_LENDING, scratch: true, ssh: [] } });
  });

  it('reads a damaged file as nothing allowed', async () => {
    writeFileSync(file, '{"https://a.example": {"scratch": "yes", "ssh": [1]}}');
    expect(await readLending(file, 'https://a.example')).toEqual({ ...NO_LENDING, scratch: false, ssh: [] });
    writeFileSync(file, 'not json');
    expect(await readLending(file, 'https://a.example')).toEqual({ ...NO_LENDING, scratch: false, ssh: [] });
  });

  it('writes one change at a time', async () => {
    await Promise.all(['a', 'b', 'c'].map((host) => changeLending(file, 'https://a.example', (l) => applyLending(l, { kind: 'ssh', host, allowed: true }))));
    expect((await readLending(file, 'https://a.example')).ssh.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('connectors and addresses lent to a server', () => {
  it('allows a connector by what it runs, and an address by its URL; takes both back by id', () => {
    let lending = applyLending({ ...NO_LENDING }, { kind: 'connector', id: 'c1', name: 'Notion', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], envKeys: ['NOTION_TOKEN'], allowed: true });
    const fingerprint = lending.connectors[0]!.fingerprint;
    expect(fingerprint).toBe(connectorFingerprint('npx', ['-y', '@notionhq/notion-mcp-server'], ['NOTION_TOKEN']));
    // The environment's names count, in any order; their values don't.
    expect(connectorFingerprint('npx', ['-y', '@notionhq/notion-mcp-server'], ['A', 'NOTION_TOKEN'])).not.toBe(fingerprint);
    expect(connectorFingerprint('npx', ['a'], ['B', 'A'])).toBe(connectorFingerprint('npx', ['a'], ['A', 'B']));
    lending = applyLending(lending, { kind: 'http', id: 'ollama', baseUrl: 'http://localhost:11434', allowed: true });
    expect(lending.http).toEqual([{ id: 'ollama', baseUrl: 'http://localhost:11434' }]);
    lending = applyLending(lending, { kind: 'connector', id: 'c1', name: '', args: [], envKeys: [], allowed: false });
    lending = applyLending(lending, { kind: 'http', id: 'ollama', allowed: false });
    expect(lending).toEqual(NO_LENDING);
    expect(() => applyLending(NO_LENDING, { kind: 'connector', id: 'c1', name: '', args: [], envKeys: [], allowed: true })).toThrow(/program/);
  });
});
