import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './line-diff.ts';

/** Applies `patch` to `before` with git (outside any repository) and returns the result. */
function applied(before: string | null, patch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-line-diff-'));
  try {
    if (before !== null) writeFileSync(join(dir, 'f.txt'), before);
    writeFileSync(join(dir, 'p.diff'), patch);
    execFileSync('git', ['apply', 'p.diff'], { cwd: dir });
    return readFileSync(join(dir, 'f.txt'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const numbered = (n: number, change: (i: number) => string | null = (i) => `line ${i}`) =>
  Array.from({ length: n }, (_, i) => change(i + 1))
    .filter((l) => l !== null)
    .join('\n') + '\n';

describe('unifiedDiff', () => {
  it('writes git’s format with three lines of context', () => {
    const before = numbered(10);
    const after = numbered(10, (i) => (i === 5 ? 'line five' : `line ${i}`));
    expect(unifiedDiff('f.txt', before, after)).toBe(
      'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,7 +2,7 @@\n line 2\n line 3\n line 4\n-line 5\n+line five\n line 6\n line 7\n line 8\n',
    );
  });

  it('describes new and deleted files', () => {
    expect(unifiedDiff('f.txt', null, 'a\nb\n')).toBe('diff --git a/f.txt b/f.txt\nnew file mode 100644\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(unifiedDiff('f.txt', 'a\n', null)).toBe('diff --git a/f.txt b/f.txt\ndeleted file mode 100644\n--- a/f.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n');
  });

  it('is empty without a change and marks binary content', () => {
    expect(unifiedDiff('f.txt', 'same\n', 'same\n')).toBe('');
    expect(unifiedDiff('f.bin', 'a\0b', 'a\0c')).toBe('diff --git a/f.bin b/f.bin\nBinary files a/f.bin and b/f.bin differ\n');
  });

  it('splits distant changes into hunks and joins near ones', () => {
    const after = numbered(40, (i) => (i === 3 ? 'three' : i === 30 ? null : i === 33 ? 'thirty-three' : `line ${i}`));
    const diff = unifiedDiff('f.txt', numbered(40), after);
    expect(diff.match(/^@@ .* @@$/gm)).toEqual(['@@ -1,6 +1,6 @@', '@@ -27,10 +27,9 @@']);
  });

  it('makes patches git can apply', () => {
    const before = numbered(200);
    const after = numbered(200, (i) => (i % 17 === 0 ? null : i % 23 === 0 ? `changed ${i}\nadded after ${i}` : `line ${i}`));
    expect(applied(before, unifiedDiff('f.txt', before, after))).toBe(after);
    expect(applied(null, unifiedDiff('f.txt', null, 'new\nfile\n'))).toBe('new\nfile\n');
  });

  it('shows a change too large to work out as the middle replaced', () => {
    const before = numbered(3000, (i) => `a${i}`);
    const after = numbered(3000, (i) => `b${i}`);
    const diff = unifiedDiff('f.txt', before, after);
    expect(diff.match(/^@@ .* @@$/gm)).toEqual(['@@ -1,3000 +1,3000 @@']);
    expect(applied(before, diff)).toBe(after);
  });
});

describe('unifiedDiff and files without a final newline', () => {
  /** Applies `patch` forward to `before`, then in reverse to the result (what Reject does), in a scratch repository. */
  function roundTrip(before: string | null, patch: string): { forward: string | null; back: string | null } {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-line-diff-'));
    const read = () => (existsSync(join(dir, 'f.txt')) ? readFileSync(join(dir, 'f.txt'), 'utf8') : null);
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      if (before !== null) writeFileSync(join(dir, 'f.txt'), before);
      execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: dir, input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
      const forward = read();
      execFileSync('git', ['apply', '--reverse', '--whitespace=nowarn', '-'], { cwd: dir, input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
      return { forward, back: read() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('marks a last line without a newline, as git does', () => {
    const before = 'const a = 1;\nconst b = 2;';
    const after = 'const a = 1;\nconst b = 3;';
    const patch = unifiedDiff('f.txt', before, after);
    expect(patch).toBe(
      'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n\\ No newline at end of file\n+const b = 3;\n\\ No newline at end of file\n',
    );
    expect(roundTrip(before, patch)).toEqual({ forward: after, back: before });
  });

  it('shows a change of the final newline alone, and empty files created or deleted', () => {
    const patch = unifiedDiff('f.txt', 'a\n', 'a');
    expect(patch).toContain('-a\n+a\n\\ No newline at end of file\n');
    expect(roundTrip('a\n', patch)).toEqual({ forward: 'a', back: 'a\n' });
    const deleted = unifiedDiff('f.txt', '', null);
    expect(deleted).toBe('diff --git a/f.txt b/f.txt\ndeleted file mode 100644\n');
    expect(roundTrip('', deleted)).toEqual({ forward: null, back: '' });
    const created = unifiedDiff('f.txt', null, '');
    expect(created).toBe('diff --git a/f.txt b/f.txt\nnew file mode 100644\n');
    expect(roundTrip(null, created)).toEqual({ forward: '', back: null });
  });

  it('round-trips random edits, with and without final newlines, through git apply forward and in reverse', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
    const words = ['a', 'b', 'c', 'x', 'foo', '', ' '];
    const lines = (n: number) => Array.from({ length: n }, () => pick(words));
    const failures: unknown[] = [];
    for (let i = 0; i < 150; i++) {
      const a = lines(Math.floor(random() * 30));
      const b = [...a];
      for (let ops = Math.floor(random() * 6); ops > 0; ops--) {
        const at = Math.floor(random() * (b.length + 1));
        const roll = random();
        if (roll < 0.33 && b.length) b.splice(at % b.length, 1 + Math.floor(random() * 3));
        else if (roll < 0.66) b.splice(at, 0, ...lines(1 + Math.floor(random() * 3)));
        else if (b.length) b[at % b.length] = pick(words);
      }
      const text = (l: string[]) => (l.length ? l.join('\n') + (random() < 0.5 ? '\n' : '') : '');
      const before = random() < 0.05 ? null : text(a);
      const after = random() < 0.05 ? null : text(b);
      const patch = unifiedDiff('f.txt', before, after);
      if (patch === '') {
        if (before !== after) failures.push({ before, after, problem: 'no patch for a change' });
        continue;
      }
      try {
        const got = roundTrip(before, patch);
        if (got.forward !== after || got.back !== before) failures.push({ before, after, got, patch });
      } catch (e) {
        failures.push({ before, after, patch, problem: String((e as { stderr?: unknown }).stderr ?? e) });
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
