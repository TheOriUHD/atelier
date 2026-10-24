import { describe, expect, it } from 'vitest';
import { clockTime, greeting, recentGroup, relativeTime } from './dates.ts';

const now = new Date(2026, 9, 13, 15, 0).getTime();
const at = (d: number, h = 12) => new Date(2026, 9, d, h).getTime();

describe('recentGroup', () => {
  it('groups by calendar day, not 24h windows', () => {
    expect(recentGroup(at(13, 0), now)).toBe('Today');
    expect(recentGroup(at(12, 23), now)).toBe('Yesterday');
    expect(recentGroup(at(8), now)).toBe(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at(8)));
    expect(recentGroup(at(6), now)).toBe('Previous 30 days');
    expect(recentGroup(at(1), now)).toBe('Previous 30 days');
    expect(recentGroup(new Date(2026, 6, 1).getTime(), now)).toBe('Older');
  });
});

describe('relativeTime', () => {
  it('rounds to a readable unit', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toMatch(/5 minutes ago/);
  });
});

describe('greeting', () => {
  it('splits the day at 5, 12 and 18, and greets night owls after midnight', () => {
    expect(greeting('Ada', new Date(2026, 0, 1, 4))).toBe('Hello, night owl');
    expect(greeting('Ada', new Date(2026, 0, 1, 9))).toBe('Morning, Ada');
    expect(greeting('Ada', new Date(2026, 0, 1, 13))).toBe('Afternoon, Ada');
    expect(greeting(undefined, new Date(2026, 0, 1, 19))).toBe('Good evening');
    expect(greeting('Ada', new Date(2026, 0, 1, 23))).toBe('Evening, Ada');
  });
});

describe('clockTime', () => {
  it("follows the computer's clock, not the language's", () => {
    const at = new Date(2026, 9, 13, 14, 25).getTime();
    expect(clockTime(at, { hourCycle: 'h23' })).toBe('14:25');
    expect(clockTime(at, { hourCycle: 'h12' })).toMatch(/^2:25\s?PM$/i);
    expect(clockTime(at, { weekday: true, hourCycle: 'h23' })).toMatch(/^\S+,? 14:25$/);
  });
});
