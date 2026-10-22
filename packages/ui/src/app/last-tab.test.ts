import { describe, expect, it } from 'vitest';
import { recalledTab, rememberTab, startHash, tabOf } from './last-tab.ts';

const store = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe('the tab the app opens on', () => {
  it('remembers Code and Chat, and treats Cowork as Chat', () => {
    const s = store();
    expect(recalledTab(s)).toBe('chat');
    rememberTab(tabOf('code'), s);
    expect(recalledTab(s)).toBe('code');
    rememberTab(tabOf('work'), s);
    expect(recalledTab(s)).toBe('chat');
  });

  it('sends only a bare start to Code’s home, keeping what was asked on top of it', () => {
    expect(startHash('', 'code')).toBe('#/code');
    expect(startHash('#/', 'code')).toBe('#/code');
    expect(startHash('#/?settings=providers', 'code')).toBe('#/code?settings=providers');
    expect(startHash('#/chat/abc', 'code')).toBeNull();
    expect(startHash('#/invite/tok', 'code')).toBeNull();
    expect(startHash('', 'chat')).toBeNull();
  });

  it('copes with storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(() => rememberTab('code', broken)).not.toThrow();
    expect(recalledTab(broken)).toBe('chat');
  });
});
