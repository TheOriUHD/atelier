import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CliConfig } from '../config.ts';
import { knownServers, terminalApp } from './known.ts';

let dir = '';
afterEach(async () => dir && (await rm(dir, { recursive: true, force: true })));

it('offers the server the desktop app uses, then the one used before, once each', async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-cli-known-'));
  const config = CliConfig.parse({ connection: { mode: 'server', serverUrl: 'https://old.example.com/' } });
  expect(await knownServers(config, dir)).toEqual([{ url: 'https://old.example.com', why: 'used before' }]);
  await writeFile(join(dir, 'connection.json'), JSON.stringify({ mode: 'server', serverUrl: 'https://atelier.example.com' }));
  expect(await knownServers(config, dir)).toEqual([
    { url: 'https://atelier.example.com', why: 'your Atelier app uses it' },
    { url: 'https://old.example.com', why: 'used before' },
  ]);
  await writeFile(join(dir, 'connection.json'), JSON.stringify({ mode: 'local' }));
  expect(await knownServers(CliConfig.parse({}), dir)).toEqual([]);
  await writeFile(join(dir, 'connection.json'), JSON.stringify({ mode: 'server', serverUrl: 'javascript:alert(1)' }));
  expect(await knownServers(CliConfig.parse({}), dir)).toEqual([]);
});

it('names the terminal app macOS asks about', () => {
  expect(terminalApp({ TERM_PROGRAM: 'iTerm.app' })).toBe('iTerm');
  expect(terminalApp({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('Terminal');
  expect(terminalApp({ TERM_PROGRAM: 'vscode', CURSOR_TRACE_ID: 'x' })).toBe('Cursor');
  expect(terminalApp({})).toBe('your terminal app');
});
