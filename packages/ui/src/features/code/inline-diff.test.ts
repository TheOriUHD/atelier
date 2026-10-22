import { describe, expect, it } from 'vitest';
import { editRows, hunkPatch, parseUnifiedDiff, writeRows } from './inline-diff.tsx';
import { displayPath, languageOf } from './paths.ts';

describe('editRows', () => {
  it('keeps shared leading and trailing lines as context around the change', () => {
    expect(editRows('a\nb\nc\nd', 'a\nB\nB2\nd')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'remove', text: 'c' },
      { kind: 'add', text: 'B' },
      { kind: 'add', text: 'B2' },
      { kind: 'context', text: 'd' },
    ]);
  });

  it('shows a pure insertion or deletion without the other side', () => {
    expect(editRows('x\n', 'x\ny\n')).toEqual([
      { kind: 'context', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
    expect(editRows('gone', '')).toEqual([{ kind: 'remove', text: 'gone' }]);
  });
});

describe('writeRows', () => {
  it('adds every line, numbered from 1, without a phantom line for the final newline', () => {
    expect(writeRows('one\ntwo\n')).toEqual([
      { kind: 'add', text: 'one', line: 1 },
      { kind: 'add', text: 'two', line: 2 },
    ]);
    expect(writeRows('')).toEqual([]);
  });
});

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 export function greet(name: string) {
-  return 'Hello, ' + name;
+  return \`Hello, \${name}!\`;
 }
@@ -10,2 +10,3 @@ export function bye() {
 const a = 1;
+const b = 2;
 const c = 3;
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3333333..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..4444444
Binary files /dev/null and b/logo.png differ
diff --git a/hello.txt b/hello.txt
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/hello.txt
@@ -0,0 +1 @@
+Hello from Atelier
\\ No newline at end of file
`;

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(DIFF);

  it('splits git output into files with their counts', () => {
    expect(files.map((f) => [f.path, f.added, f.removed, f.binary])).toEqual([
      ['src/app.ts', 2, 1, false],
      ['old.txt', 0, 1, false],
      ['logo.png', 0, 0, true],
      ['hello.txt', 1, 0, false],
    ]);
  });

  it('numbers removed lines on the old side and the rest on the new side', () => {
    expect(files[0]!.rows).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'context', text: 'export function greet(name: string) {', line: 1 },
      { kind: 'remove', text: "  return 'Hello, ' + name;", line: 2 },
      { kind: 'add', text: '  return `Hello, ${name}!`;', line: 2 },
      { kind: 'context', text: '}', line: 3 },
      { kind: 'hunk', text: '@@ -10,2 +10,3 @@ export function bye() {' },
      { kind: 'context', text: 'const a = 1;', line: 10 },
      { kind: 'add', text: 'const b = 2;', line: 11 },
      { kind: 'context', text: 'const c = 3;', line: 12 },
    ]);
    expect(files[3]!.rows.at(-1)).toEqual({ kind: 'add', text: 'Hello from Atelier', line: 1 });
  });

  it('keeps each file’s raw header and hunks, so one hunk can be sent back as a patch', () => {
    const [app, old, logo, hello] = files;
    expect(app!.hunks).toHaveLength(2);
    expect(hunkPatch(app!, 1)).toBe(
      'diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n' +
        '@@ -10,2 +10,3 @@ export function bye() {\n const a = 1;\n+const b = 2;\n const c = 3;\n',
    );
    expect(hunkPatch(old!, 0)).toBe(DIFF.slice(DIFF.indexOf('diff --git a/old.txt'), DIFF.indexOf('diff --git a/logo.png')));
    expect(logo!.hunks).toEqual([]);
    // The no-newline marker belongs to its hunk, or the patch doesn't apply.
    expect(hunkPatch(hello!, 0)).toBe(DIFF.slice(DIFF.indexOf('diff --git a/hello.txt')));
  });

  it('takes a rename’s new path', () => {
    const [renamed] = parseUnifiedDiff('diff --git a/a.ts b/b.ts\nsimilarity index 90%\nrename from a.ts\nrename to b.ts\n');
    expect(renamed!.path).toBe('b.ts');
  });
});

describe('paths', () => {
  it('names the language by extension, or by file name', () => {
    expect(languageOf('src/App.TSX')).toBe('tsx');
    expect(languageOf('/repo/Dockerfile')).toBe('dockerfile');
    expect(languageOf('C:\\repo\\main.go')).toBe('go');
  });

  it('shows paths relative to the workspace root when inside it', () => {
    expect(displayPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(displayPath('/repository/a.ts', '/repo')).toBe('/repository/a.ts');
    expect(displayPath('C:\\repo\\a.ts', 'C:\\repo')).toBe('a.ts');
    expect(displayPath('/elsewhere/a.ts', null)).toBe('/elsewhere/a.ts');
  });
});
