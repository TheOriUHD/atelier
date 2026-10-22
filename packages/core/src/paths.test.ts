import { describe, expect, it } from 'vitest';
import { pathOps } from './paths.ts';

describe('pathOps', () => {
  describe('on Windows', () => {
    const ops = pathOps('win32');

    it('compares one folder written three ways as the same', () => {
      const root = 'C:\\Users\\me\\app';
      expect(ops.within('C:/Users/me/app/src/a.ts', root)).toBe(true);
      expect(ops.within('c:\\users\\ME\\App\\src', root)).toBe(true);
      expect(ops.within('C:\\Users\\me\\app\\', 'C:/Users/me/app')).toBe(true);
      expect(ops.within('C:\\Users\\me\\app', root)).toBe(true);
    });

    it('is not fooled by a sibling that shares a prefix or by another drive', () => {
      expect(ops.within('C:\\Users\\me\\app2\\a.ts', 'C:\\Users\\me\\app')).toBe(false);
      expect(ops.within('D:\\Users\\me\\app\\a.ts', 'C:\\Users\\me\\app')).toBe(false);
      expect(ops.within('C:\\Users\\me', 'C:\\Users\\me\\app')).toBe(false);
    });

    it('tells below from within', () => {
      expect(ops.below('C:\\a\\b', 'C:/a/b')).toBe(false);
      expect(ops.below('C:\\a\\b\\c', 'C:/a/b')).toBe(true);
    });

    it('takes a relative path from the folder it is relative to', () => {
      expect(ops.absolute('..\\x\\y.ts', 'C:\\a\\b')).toBe('C:\\a\\x\\y.ts');
      expect(ops.absolute('C:/other/z', 'C:\\a\\b')).toBe('C:\\other\\z');
    });

    it('gives the part below the root with its own case', () => {
      expect(ops.relative('C:\\Work\\App\\Src\\Ui\\A.ts', 'c:/work/app')).toBe('Src/Ui/A.ts');
      expect(ops.relative('C:\\work\\other', 'C:\\work\\app')).toBeNull();
      expect(ops.relative('C:\\work\\app', 'C:\\work\\app')).toBeNull();
    });

    it('keeps a drive root a root', () => {
      expect(ops.within('C:\\x', 'C:\\')).toBe(true);
      expect(ops.relative('C:\\x\\y', 'C:/')).toBe('x/y');
    });
  });

  describe('on macOS and Linux', () => {
    const ops = pathOps('posix');

    it('is case sensitive and keeps backslashes as the characters they are', () => {
      expect(ops.within('/Work/app/a', '/work/app')).toBe(false);
      expect(ops.within('/work/app/a\\b', '/work/app')).toBe(true);
      expect(ops.relative('/work/app/a\\b/c', '/work/app')).toBe('a\\b/c');
    });

    it('is not fooled by a sibling that shares a prefix', () => {
      expect(ops.within('/work/app2/a', '/work/app')).toBe(false);
      expect(ops.within('/work/app/', '/work/app')).toBe(true);
      expect(ops.within('/anything', '/')).toBe(true);
    });
  });
});
