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

describe('usage summary of images', () => {
  it('counts the images of a row and how much of its cost is an estimate', async () => {
    const db = openDatabase(':memory:');
    await db.insert(users).values({ id: 'ada', username: 'ada', name: 'ada', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
    const at = Date.parse('2026-10-13T09:00:00Z');
    const event = (id: string, extra: Partial<typeof usageEvents.$inferInsert>) =>
      db.insert(usageEvents).values({ id, ts: at, userId: 'ada', providerId: 'openai-images', modelId: 'gpt-image-2', mode: 'chat', input: 0, output: 0, ...extra });
    await event('1', { images: 2, costUsd: 0.08, costEstimated: true });
    await event('2', { images: 1, costUsd: 0.05 });
    await event('3', { modelId: 'text', input: 100, output: 10 });

    const rows = usageSummary(db, { userId: 'ada', days: 7, timezoneOffset: 0, now: at });
    expect(rows.find((r) => r.modelId === 'gpt-image-2')).toMatchObject({ images: 3, costUsd: 0.13, estimatedUsd: 0.08, input: 0 });
    expect(rows.find((r) => r.modelId === 'text')).toMatchObject({ images: 0, estimatedUsd: 0 });
  });
});

describe('usage summary of videos', () => {
  it('counts the clips of a row and their seconds, and keeps them out of the model card of the stats', async () => {
    const db = openDatabase(':memory:');
    await db.insert(users).values({ id: 'ada', username: 'ada', name: 'ada', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
    await db.insert(sessions).values({ id: 's1', userId: 'ada', mode: 'chat', title: 't', createdAt: 0, updatedAt: 0 });
    const at = Date.parse('2026-10-13T09:00:00Z');
    const event = (id: string, extra: Partial<typeof usageEvents.$inferInsert>) =>
      db.insert(usageEvents).values({ id, ts: at, userId: 'ada', sessionId: 's1', providerId: 'fal', modelId: 'kling', mode: 'chat', input: 0, output: 0, ...extra });
    await event('1', { videos: 1, videoSeconds: 5, costUsd: 0.8, costEstimated: true });
    await event('2', { videos: 1, videoSeconds: 8, costUsd: 1.25 });
    await event('3', { modelId: 'text', input: 100, output: 10 });
    const rows = usageSummary(db, { userId: 'ada', days: 7, timezoneOffset: 0, now: at });
    expect(rows.find((r) => r.modelId === 'kling')).toMatchObject({ videos: 2, videoSeconds: 13, images: 0, costUsd: 2.05, estimatedUsd: 0.8, input: 0 });
    expect(rows.find((r) => r.modelId === 'text')).toMatchObject({ videos: 0, videoSeconds: 0 });
    expect(statsSummary(db, { userId: 'ada', mode: 'chat', days: null, timezoneOffset: 0, now: at }).models.map((m) => m.ref)).toEqual(['fal/text']);
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
    // An image has no tokens: it's neither a model on the card nor the favorite.
    await event('s2', '2026-10-13T07:02:00Z', 'an-image-model', 0, { images: 2 });

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
