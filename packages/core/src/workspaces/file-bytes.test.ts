import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { MAX_FILE_BYTES, fileBytes } from './file-bytes.ts';
import { hostRunnerBinary } from './runner-client.ts';
import type { Workspace } from './workspace.ts';
import { WorkspaceManager } from './workspace-manager.ts';

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../runner/bin'));
const built = existsSync(binary);

let db: Db;
let dir: string;
let outside: string;
let manager: WorkspaceManager;
let ws: Workspace;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeEach(async () => {
  if (!built) return;
  db = openDatabase(':memory:');
  await db.insert(users).values({ id: 'ada', username: 'ada', name: 'Ada', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-bytes-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-bytes-outside-')));
  manager = new WorkspaceManager({ db, runnerBinary: binary, logger: { info: () => {}, error: () => {} } });
  mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'out', 'chart.png'), PNG);
  writeFileSync(join(dir, 'report.docx'), 'not really a docx');
  writeFileSync(join(outside, 'secret.txt'), 'keep out');
  ws = await manager.open('ada', (await manager.addLocal('ada', dir)).id);
});
afterEach(async () => {
  if (!built) return;
  await manager.disposeAll();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe.skipIf(!built)('fileBytes', () => {
  it('returns the bytes with an inline type for images and a download type for the rest', async () => {
    const image = await fileBytes(ws, 'out/chart.png');
    expect(image).toMatchObject({ mime: 'image/png', size: PNG.length });
    expect(Buffer.from(image.dataBase64, 'base64').equals(PNG)).toBe(true);
    expect(await fileBytes(ws, join(dir, 'report.docx'))).toMatchObject({ mime: 'application/octet-stream', size: 17 });
  });

  it('refuses folders, files outside the workspace and files over the cap', async () => {
    await expect(fileBytes(ws, 'out')).rejects.toThrow(/isn’t a file/);
    await expect(fileBytes(ws, join(outside, 'secret.txt'))).rejects.toThrow(/outside/);
    writeFileSync(join(dir, 'huge.bin'), '');
    truncateSync(join(dir, 'huge.bin'), MAX_FILE_BYTES + 1);
    await expect(fileBytes(ws, 'huge.bin')).rejects.toThrow(/larger than 16 MB/);
  });
});
