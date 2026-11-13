import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageAddress, previewTarget } from '@atelier/protocol';
import { hostRunnerBinary, RunnerClient } from '../workspaces/runner-client.ts';
import type { Workspace } from '../workspaces/workspace.ts';
import { createPreviewTool, insideRoot } from './preview.ts';
import { describeTool } from './types.ts';

const ctx = () => ({ sessionId: 's', messageId: 'm1', callId: 'c1', signal: new AbortController().signal, emit: () => {} });
const text = (out: { content: { type: string; text?: string }[] }) => out.content.map((c) => c.text ?? '').join('');

describe('what Preview opens', () => {
  it('takes an address as it is, and a local one without its scheme', () => {
    expect(pageAddress('http://localhost:5173')).toBe('http://localhost:5173/');
    expect(pageAddress('localhost:5173/docs')).toBe('http://localhost:5173/docs');
    expect(pageAddress('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(pageAddress('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(pageAddress('site/index.html')).toBeNull();
    expect(pageAddress('index.html')).toBeNull();
  });

  it('knows a path inside the workspace, on macOS, Linux and Windows', () => {
    expect(insideRoot('/home/ada/site/index.html', '/home/ada/site')).toBe('index.html');
    expect(insideRoot('/home/ada/site/pages/a.html', '/home/ada/site/')).toBe('pages/a.html');
    expect(insideRoot('/home/ada/siteX/a.html', '/home/ada/site')).toBeNull();
    expect(insideRoot('/home/ada/site', '/home/ada/site')).toBeNull();
    expect(insideRoot('C:\\Users\\Ada\\Site\\index.html', 'c:\\users\\ada\\site')).toBe('index.html');
  });

  it('is read back from a successful call, for the app to open', () => {
    expect(previewTarget({ page: 'localhost:3000' }, 'Opened http://localhost:3000/ in the browser pane beside the conversation.')).toEqual({ kind: 'url', url: 'http://localhost:3000/' });
    expect(previewTarget({ page: './site' }, 'Opened site/index.html in the browser pane beside the conversation, with the files beside it as they are on disk.')).toEqual({ kind: 'file', path: 'site/index.html' });
    expect(previewTarget({ page: 'nope.html' }, "Couldn't open nope.html: no such file")).toBeNull();
  });

  it('says how it differs from an artifact, in both tiers', () => {
    const tool = createPreviewTool({ runner: {} } as unknown as Workspace);
    const full = describeTool(tool, { tier: 'full', mode: 'code', has: () => true }).description;
    expect(full).toContain('there is no need to put it in one file');
    expect(full).toContain('ES modules');
    expect(describeTool(tool, { tier: 'compact', mode: 'code', has: () => true }).description).toContain('no bundling');
  });
});

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../runner/bin'));

describe.skipIf(!existsSync(binary))('Preview in a workspace', { timeout: 30_000 }, () => {
  let tmp: string;
  let client: RunnerClient;
  let workspace: Workspace;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'atelier-preview-'));
    const root = join(tmp, 'workspace');
    mkdirSync(join(root, 'site'), { recursive: true });
    writeFileSync(join(root, 'site', 'index.html'), '<link rel="stylesheet" href="style.css"><h1>Hi</h1>');
    writeFileSync(join(root, 'site', 'style.css'), 'h1 { color: tomato }');
    writeFileSync(join(tmp, 'outside.html'), '<p>outside</p>');
    client = await RunnerClient.spawn({ binaryPath: binary, roots: [root] });
    const { info } = client;
    workspace = { id: 'w', deviceId: null, host: null, root: info.roots[0]!, home: info.home, os: info.os, shell: info.shell, pathSep: info.pathSep, runner: client, shellFor: async () => 'shell' };
  });
  afterAll(async () => {
    await client?.shutdown();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('opens a page by its path from the root, a folder by its index.html, and an address as it is', async () => {
    const tool = createPreviewTool(workspace);
    const opened = await tool.run({ page: 'site/index.html' }, ctx());
    expect(opened.isError).toBeUndefined();
    expect(previewTarget({ page: 'site/index.html' }, text(opened))).toEqual({ kind: 'file', path: 'site/index.html' });
    expect(previewTarget({ page: 'site' }, text(await tool.run({ page: 'site' }, ctx())))).toEqual({ kind: 'file', path: 'site/index.html' });
    expect(previewTarget({ page: join(workspace.root, 'site', 'index.html') }, text(await tool.run({ page: join(workspace.root, 'site', 'index.html') }, ctx())))).toEqual({ kind: 'file', path: 'site/index.html' });
    expect(text(await tool.run({ page: 'localhost:5173' }, ctx()))).toBe('Opened http://localhost:5173/ in the browser pane beside the conversation.');
  });

  it('refuses what it can’t show', async () => {
    const tool = createPreviewTool(workspace);
    const missing = await tool.run({ page: 'site/missing.html' }, ctx());
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^Couldn't open site\/missing\.html/);
    expect((await tool.run({ page: 'file:///etc/passwd' }, ctx())).isError).toBe(true);
    expect((await tool.run({ page: '  ' }, ctx())).isError).toBe(true);
    // Outside the workspace: the runner refuses it, or Preview does.
    const outside = await tool.run({ page: join(tmp, 'outside.html') }, ctx());
    expect(outside.isError).toBe(true);
  });
});
