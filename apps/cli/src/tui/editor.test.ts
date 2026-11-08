import { describe, expect, it } from 'vitest';
import * as ed from './editor.ts';

const at = (text: string, cursor: number) => ({ ...ed.emptyEditor(text), cursor });

describe('the message box editor', () => {
  it('types, deletes whole characters (emoji included) and undoes', () => {
    let s = ed.insert(ed.emptyEditor(), 'hi 👋🏽');
    expect(s.text).toBe('hi 👋🏽');
    s = ed.backspace(s);
    expect(s.text).toBe('hi ');
    s = ed.undo(s);
    expect(s.text).toBe('hi 👋🏽');
  });

  it('moves by word and line, keeping the column', () => {
    const s = at('first line\nsecond', 3);
    expect(ed.wordRight(s).cursor).toBe(5);
    expect(ed.wordLeft(at('one two', 7)).cursor).toBe(4);
    const down = ed.down(s)!;
    expect(down.cursor).toBe(11 + 3);
    expect(ed.up(down)!.cursor).toBe(3);
    expect(ed.up(s)).toBeNull();
    expect(ed.down(down)).toBeNull();
    expect(ed.home(down).cursor).toBe(11);
    expect(ed.end(s).cursor).toBe(10);
  });

  it('kills and yanks as a shell does', () => {
    let s = at('git commit -m wip', 17);
    s = ed.killWordBack(s);
    expect(s.text).toBe('git commit -m ');
    s = ed.yank(s);
    expect(s.text).toBe('git commit -m wip');
    s = ed.killToStart(at('abc def', 4));
    expect([s.text, s.killed]).toEqual(['def', 'abc ']);
    s = ed.killToEnd(at('abc\ndef', 3));
    expect(s.text).toBe('abcdef');
  });

  it('says where the cursor is', () => {
    expect(ed.position(at('ab\ncd', 4))).toEqual({ line: 1, column: 1 });
  });
});
