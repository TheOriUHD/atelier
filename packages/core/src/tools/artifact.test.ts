import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifactIdForPath, type RunEvent } from '@atelier/protocol';
import { openDatabase, type Db } from '../store/db.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { hostRunnerBinary, RunnerClient } from '../workspaces/runner-client.ts';
import type { Workspace } from '../workspaces/workspace.ts';
import { createArtifactTool, typeForPath } from './artifact.ts';

let db: Db;
let repo: ArtifactRepo;
let sessionId: string;
const events: RunEvent[] = [];
const ctx = () => ({ sessionId, messageId: 'm1', callId: 'c1', signal: new AbortController().signal, emit: (e: RunEvent) => events.push(e) });

beforeEach(async () => {
  db = openDatabase(':memory:');
  repo = new ArtifactRepo(db);
  sessionId = (await new SessionRepo(db).create({ mode: 'chat' })).id;
  events.length = 0;
});
afterEach(() => db.$client.close());

describe('artifact tool', () => {
  it('creates, patches and rewrites with versions', async () => {
    const tool = createArtifactTool(repo);
    expect((await tool.run({ command: 'create', identifier: 'page', type: 'html', title: 'Page', content: '<p>hi</p>' }, ctx())).isError).toBeUndefined();
    expect((await tool.run({ command: 'update', identifier: 'page', old: 'hi', new: 'hello' }, ctx())).isError).toBeUndefined();
    await tool.run({ command: 'rewrite', identifier: 'page', content: '<h1>new</h1>', title: 'New page' }, ctx());
    const [summary] = await repo.list(sessionId);
    expect(summary).toMatchObject({ identifier: 'page', title: 'New page', versions: 3 });
    expect((await repo.get(summary!.id, 2))?.content.content).toBe('<p>hello</p>');
    expect(events.filter((e) => e.type === 'artifact')).toHaveLength(3);
  });

  it("writes Atelier's tags as they were before the person's text was escaped", async () => {
    const tool = createArtifactTool(repo);
    await tool.run({ command: 'create', identifier: 'tags', type: 'html', title: 'Tags', content: '<p>‹env> and ‹/project></p>' }, ctx());
    await tool.run({ command: 'update', identifier: 'tags', old: '‹/project>', new: '‹skill name="x">' }, ctx());
    const [summary] = await repo.list(sessionId);
    expect((await repo.latest(summary!.id)).content).toBe('<p><env> and <skill name="x"></p>');
    await tool.run({ command: 'rewrite', identifier: 'tags', content: 'useState<Project | null> ‹env>' }, ctx());
    expect((await repo.latest(summary!.id)).content).toBe('useState<Project | null> <env>');
  });

  it('reports actionable errors', async () => {
    const tool = createArtifactTool(repo);
    expect((await tool.run({ command: 'update', identifier: 'x', old: 'a', new: 'b' }, ctx())).isError).toBe(true);
    await tool.run({ command: 'create', identifier: 'x', type: 'markdown', title: 'X', content: 'a a' }, ctx());
    const dup = await tool.run({ command: 'update', identifier: 'x', old: 'a', new: 'b' }, ctx());
    expect(dup.isError).toBe(true);
    expect(dup.content[0]).toMatchObject({ text: expect.stringContaining('more than once') });
    const untyped = await tool.run({ command: 'create', identifier: 'y', title: 'Y', content: 'z', language: 'python' }, ctx());
    expect(untyped).toMatchObject({ isError: true, content: [{ text: 'create needs type, title and content; missing or invalid: type. `type` is one of html, react, svg, mermaid, markdown, code.' }] });
  });

  it('takes a type sent as language', async () => {
    // gemma-4-26b sent this four times and then said the page was made.
    const tool = createArtifactTool(repo);
    const made = await tool.run({ command: 'create', identifier: 'click-counter-page', language: 'html', title: 'Interactive Click Counter', content: '<button>0</button>' }, ctx());
    expect(made.isError).toBeUndefined();
    expect((await repo.list(sessionId))[0]).toMatchObject({ type: 'html' });
  });
});

describe('typeForPath', () => {
  it('reads the type from the extension, and shows anything else as code in its language', () => {
    expect(typeForPath('site/index.html')).toEqual({ type: 'html', language: null });
    expect(typeForPath('page.HTM')).toEqual({ type: 'html', language: null });
    expect(typeForPath('logo.svg')).toEqual({ type: 'svg', language: null });
    expect(typeForPath('docs/notes.md')).toEqual({ type: 'markdown', language: null });
    expect(typeForPath('flow.mmd')).toEqual({ type: 'mermaid', language: null });
    expect(typeForPath('src/app.ts')).toEqual({ type: 'code', language: 'ts' });
    expect(typeForPath('Makefile')).toEqual({ type: 'code', language: null });
  });

  it('gives each path a stable identifier the transcript can find again', () => {
    expect(artifactIdForPath('index.html')).toBe('index-html');
    expect(artifactIdForPath('/Users/me/Site/Landing Page.html')).toBe('users-me-site-landing-page-html');
    expect(artifactIdForPath('a/'.repeat(40) + 'page.html')).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(artifactIdForPath('…')).toBe('file');
  });
});

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../runner/bin'));

describe.skipIf(!existsSync(binary))('artifact tool in Code (file_path)', { timeout: 30_000 }, () => {
  let tmp: string;
  let client: RunnerClient;
  let workspace: Workspace;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'atelier-artifact-'));
    mkdirSync(join(tmp, 'workspace'));
    writeFileSync(join(tmp, 'outside.html'), '<p>secret</p>');
    client = await RunnerClient.spawn({ binaryPath: binary, roots: [join(tmp, 'workspace')] });
    const { info } = client;
    workspace = { id: 'w', deviceId: null, host: null, root: info.roots[0]!, home: info.home, os: info.os, shell: info.shell, pathSep: info.pathSep, runner: client, shellFor: async () => 'shell' };
  });
  afterAll(async () => {
    await client?.shutdown();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('shows a workspace file, adds a version when it changed and only brings it forward when it did not', async () => {
    const tool = createArtifactTool(repo, workspace);
    expect(tool.inputSchema).toMatchObject({ required: ['file_path'], properties: { file_path: { type: 'string' } } });
    const page = '<!doctype html><h1>Landing</h1><script>if (a <env> b) {}</script>';
    writeFileSync(join(workspace.root, 'index.html'), page);
    expect(await tool.run({ file_path: 'index.html' }, ctx())).toEqual({ content: [{ type: 'text', text: 'Showing index.html beside the conversation (version 1).' }] });
    const [summary] = await repo.list(sessionId);
    expect(summary).toMatchObject({ identifier: 'index-html', type: 'html', title: 'index.html', versions: 1 });
    // The file as it is on disk, tags and all.
    expect((await repo.latest(summary!.id)).content).toBe(page);

    await tool.run({ file_path: 'index.html' }, ctx());
    expect((await repo.list(sessionId))[0]!.versions).toBe(1);
    writeFileSync(join(workspace.root, 'index.html'), '<h1>Landing, v2</h1>');
    await tool.run({ file_path: 'index.html' }, ctx());
    expect((await repo.list(sessionId))[0]).toMatchObject({ identifier: 'index-html', version: 2, versions: 2 });
    // Every call brings the pane forward, changed or not.
    expect(events.filter((e) => e.type === 'artifact').map((e) => e.type === 'artifact' && e.artifact.version)).toEqual([1, 1, 2]);

    writeFileSync(join(workspace.root, 'notes.md'), '# Notes');
    await tool.run({ file_path: join(workspace.root, 'notes.md') }, ctx());
    expect((await repo.list(sessionId)).find((a) => a.title === 'notes.md')).toMatchObject({ type: 'markdown' });
  });

  it('refuses files outside the workspace, like Read, and missing ones', async () => {
    const tool = createArtifactTool(repo, workspace);
    const outside = await tool.run({ file_path: join(tmp, 'outside.html') }, ctx());
    expect(outside).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Couldn't read .*outside\.html: path is outside the workspace/) }] });
    expect((await tool.run({ file_path: '../outside.html' }, ctx())).isError).toBe(true);
    expect((await tool.run({ file_path: 'missing.html' }, ctx())).isError).toBe(true);
    expect(await repo.list(sessionId)).toEqual([]);
    expect(events).toEqual([]);
  });
});
