import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe as group, expect, it } from 'vitest';
import { describe, logMain, openMainLog } from './main-log.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-log-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

group('the main log', () => {
  it('writes timestamped lines, and moves a full log aside', () => {
    const file = openMainLog(join(dir, 'logs'));
    logMain('start 1.0.0');
    logMain(`start failed: ${describe(new Error('boom'))}`);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z start 1\.0\.0\n/);
    expect(text).toContain('Error: boom');
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
    logMain('after');
    expect(existsSync(join(dir, 'logs', 'main.old.log'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/after\n$/);
  });
});
