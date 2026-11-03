import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe as group, expect, it } from 'vitest';
import { describe, logMain, openMainLog, readMainLogTail } from './main-log.ts';

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

group('reading the end of the main log', () => {
  it('returns the last lines in order, and nothing before the log is opened or when it is empty', () => {
    expect(readMainLogTail(5)).toEqual([]);
    const file = openMainLog(join(dir, 'logs'));
    expect(readMainLogTail(5)).toEqual([]);
    for (let i = 0; i < 10; i++) logMain(`line ${i}`);
    const tail = readMainLogTail(3);
    expect(tail).toHaveLength(3);
    expect(tail[2]).toMatch(/line 9$/);
    expect(tail[0]).toMatch(/line 7$/);
    expect(readMainLogTail(100)).toHaveLength(10);
    expect(readMainLogTail(0)).toEqual([]);
    expect(file).toContain('main.log');
  });

  it('reads only the end of a big log, drops the half line it starts in, and cuts a huge line', () => {
    const file = openMainLog(join(dir, 'logs'));
    writeFileSync(file, `${'old line\n'.repeat(100_000)}${'x'.repeat(5000)}\nlast\n`);
    const tail = readMainLogTail(100);
    expect(tail.at(-1)).toBe('last');
    expect(tail.at(-2)!.length).toBeLessThanOrEqual(2001);
    expect(tail.every((l) => l === 'old line' || l.startsWith('x') || l === 'last')).toBe(true);
  });

  it('gives an empty list when the file cannot be read', () => {
    const file = openMainLog(join(dir, 'logs'));
    rmSync(join(dir, 'logs'), { recursive: true, force: true });
    expect(readMainLogTail(5)).toEqual([]);
    expect(file).toBeTruthy();
  });
});
