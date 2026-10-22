import { describe, expect, it } from 'vitest';
import { openDatabase } from '../store/db.ts';
import { messages, sessions, usageEvents, users } from '../store/schema.ts';
import { statsSummary, usageSummary } from './usage.ts';

describe('usage summary', () => {
  it('groups by the person’s local day, model and mode, with priced and unpriced requests apart', async () => {
    const db = openDatabase(':memory:');
    for (const id of ['ada', 'bob']) await db.insert(users).values({ id, username: id, name: id, role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
    const at = (iso: string) => Date.parse(iso);
    const event = (id: string, ts: number, userId: string, extra: Partial<typeof usageEvents.$inferInsert> = {}) =>
      db.insert(usageEvents).values({ id, ts, userId, providerId: 'anthropic', modelId: 'claude-sonnet-5-5', mode: 'chat', input: 100, output: 10, ...extra });
    // 23:30 UTC on the 12th is already the 13th in Berlin (UTC+2, offset -120).
    await event('1', at('2026-10-12T23:30:00Z'), 'ada', { costUsd: 0.5, tokensPerSecond: 40 });
    await event('2', at('2026-10-13T08:00:00Z'), 'ada', { tokensPerSecond: 60 });
    await event('3', at('2026-10-13T09:00:00Z'), 'ada', { mode: 'code', providerId: 'ollama', modelId: 'qwen3' });
    await event('4', at('2026-10-13T09:00:00Z'), 'bob');
    await event('5', at('2026-10-05T09:00:00Z'), 'ada');

    const now = at('2026-10-13T12:00:00Z');
    const rows = usageSummary(db, { userId: 'ada', days: 7, timezoneOffset: -120, now });
    expect(rows.map((r) => [r.day, r.providerId, r.mode, r.requests, r.input, r.costUsd, r.unpriced, r.tokensPerSecond, r.timed])).toEqual([
      ['2026-10-13', 'anthropic', 'chat', 2, 200, 0.5, 1, 50, 2],
      ['2026-10-13', 'ollama', 'code', 1, 100, null, 1, null, 0],
    ]);
    expect(usageSummary(db, { userId: null, days: 7, timezoneOffset: -120, now }).reduce((n, r) => n + r.requests, 0)).toBe(4);
    expect(usageSummary(db, { userId: 'ada', days: 7, timezoneOffset: 0, now }).map((r) => r.day)).toEqual(['2026-10-12', '2026-10-13', '2026-10-13']);
  });
});

describe('stats summary', () => {
  it('counts one person’s root sessions in a mode by local day and hour, with sub-agents’ tokens on their parent', async () => {
    const db = openDatabase(':memory:');
    for (const id of ['ada', 'bob']) await db.insert(users).values({ id, username: id, name: id, role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
    const at = (iso: string) => Date.parse(iso);
    const session = (id: string, userId: string, mode: 'work' | 'code', parentSessionId: string | null = null) =>
      db.insert(sessions).values({ id, userId, mode, parentSessionId, createdAt: 0, updatedAt: 0 });
    let n = 0;
    const message = (sessionId: string, iso: string, role: 'user' | 'assistant' | 'tool' = 'user', kind: 'normal' | 'context' = 'normal') =>
      db.insert(messages).values({ id: `m${n++}`, sessionId, role, kind, parts: [], createdAt: at(iso) });
    const event = (sessionId: string, iso: string, modelId: string, input: number, extra: Partial<typeof usageEvents.$inferInsert> = {}) =>
      db.insert(usageEvents).values({ id: `e${n++}`, ts: at(iso), userId: 'ada', providerId: 'local', modelId, sessionId, mode: 'code', input, output: 0, ...extra });
    await session('s1', 'ada', 'code');
    await session('s2', 'ada', 'code');
    await session('sub', 'ada', 'code', 's1');
    await session('w1', 'ada', 'work');
    await session('b1', 'bob', 'code');
    // Berlin (UTC+2, offset -120): 21:30 UTC on the 12th is 23:30 there, 22:10 UTC already the 13th.
    await message('s1', '2026-10-12T21:30:00Z');
    await message('s1', '2026-10-12T22:05:00Z', 'tool');
    await message('s1', '2026-10-12T22:06:00Z', 'user', 'context');
    await message('s1', '2026-10-12T22:10:00Z', 'assistant');
    await message('s2', '2026-10-13T07:00:00Z');
    await message('s2', '2026-10-13T07:01:00Z', 'assistant');
    await message('s2', '2026-09-01T07:00:00Z');
    await message('s1', '2026-01-05T10:00:00Z');
    await message('sub', '2026-10-13T07:00:00Z');
    await message('w1', '2026-10-13T07:00:00Z');
    await message('b1', '2026-10-13T07:00:00Z');
    await event('s1', '2026-10-12T21:31:00Z', 'large', 1000, { output: 100 });
    await event('sub', '2026-10-12T21:32:00Z', 'large', 500, { output: 50, cacheRead: 50 });
    await event('s2', '2026-10-13T07:01:00Z', 'small', 200, { output: 20 });
    await event('s2', '2026-09-01T07:01:00Z', 'small', 5000);
    await event('w1', '2026-10-13T07:01:00Z', 'small', 9999);
    await event('b1', '2026-10-13T07:01:00Z', 'small', 9999);

    const now = at('2026-10-13T12:00:00Z');
    const stats = (opts: { userId?: string; mode?: 'code' | 'work'; days?: number | null; timezoneOffset?: number }) =>
      statsSummary(db, { userId: 'ada', mode: 'code', days: null, timezoneOffset: -120, now, ...opts });

    // The heatmap covers 26 weeks whatever the period (January is older than that).
    expect(stats({ days: 7 })).toEqual({
      sessions: 2,
      messages: 4,
      tokens: 1920,
      activeDays: 2,
      peakHour: 9,
      favoriteModel: 'local/large',
      days: [
        { day: '2026-09-01', sessions: 1, messages: 1 },
        { day: '2026-10-12', sessions: 1, messages: 1 },
        { day: '2026-10-13', sessions: 2, messages: 3 },
      ],
      models: [
        { ref: 'local/large', tokens: 1700, requests: 2 },
        { ref: 'local/small', tokens: 220, requests: 1 },
      ],
    });
    expect(stats({})).toMatchObject({ sessions: 2, messages: 6, tokens: 6920, activeDays: 4, peakHour: 9, favoriteModel: 'local/small' });
    expect(stats({ days: 7, timezoneOffset: 0 }).days.slice(1)).toEqual([
      { day: '2026-10-12', sessions: 1, messages: 2 },
      { day: '2026-10-13', sessions: 1, messages: 2 },
    ]);
    expect(stats({ mode: 'work' })).toMatchObject({ sessions: 1, messages: 1, tokens: 9999 });
    expect(stats({ userId: 'bob' })).toMatchObject({ sessions: 1, messages: 1, tokens: 9999 });
    expect(stats({ userId: 'bob', mode: 'work' })).toEqual({ sessions: 0, messages: 0, tokens: 0, activeDays: 0, peakHour: null, favoriteModel: null, days: [], models: [] });
  });
});
