import { describe, expect, it } from 'vitest';
import type { LimitsSettings, UserLimits } from '@atelier/protocol';
import { openDatabase } from '../store/db.ts';
import { usageEvents, users } from '../store/schema.ts';
import { describeReset, UsageLimits } from './limits.ts';

const at = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A limits counter over a fresh database with the people `ada` and `bob`, and a clock the test moves. */
async function setup(limits: LimitsSettings, overrides: Record<string, UserLimits> = {}, start = '2026-11-02T10:00:00Z') {
  const db = openDatabase(':memory:');
  for (const id of ['ada', 'bob']) await db.insert(users).values({ id, username: id, name: id, role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  const clock = { now: at(start) };
  const system = { limits };
  const counter = new UsageLimits({
    db,
    settings: () => system,
    person: async (id) => overrides[id] ?? null,
    admins: async () => ['Grace'],
    now: () => clock.now,
  });
  let n = 0;
  const insert = (userId: string, ts: number, extra: Partial<typeof usageEvents.$inferInsert> = {}) =>
    db.insert(usageEvents).values({ id: `e${n++}`, ts, userId, providerId: 'p', modelId: 'm', mode: 'chat', input: 60, output: 40, ...extra });
  return { db, clock, counter, system, insert, overrides };
}

const refused = async (counter: UsageLimits, userId = 'ada') => {
  const a = await counter.admit(userId);
  if (!a.error) a.release();
  return a.error ? a : null;
};

describe('seeding from usage events', () => {
  it('counts a person’s text requests of today and the 29 UTC days before, and nothing else', async () => {
    const { counter, insert } = await setup({ tokensPerDay: 1000, tokensPer30Days: 10_000 });
    await insert('ada', at('2026-11-02T01:00:00Z'));
    await insert('ada', at('2026-11-02T09:00:00Z'), { cacheRead: 50, cacheWrite: 10 });
    // Yesterday and the oldest day still inside the window (Oct 4 is 29 days before Nov 2); Oct 3 is out.
    await insert('ada', at('2026-11-01T23:59:00Z'));
    await insert('ada', at('2026-10-04T00:00:00Z'));
    await insert('ada', at('2026-10-03T23:59:00Z'));
    // Not hers, and an image row, which has limits of its own.
    await insert('bob', at('2026-11-02T08:00:00Z'));
    await insert('ada', at('2026-11-02T08:00:00Z'), { input: 0, output: 0, images: 2, costUsd: 5 });
    const status = await counter.status('ada');
    expect(status.rows.find((r) => r.key === 'tokensPerDay')).toMatchObject({ used: 100 + 160, max: 1000 });
    expect(status.rows.find((r) => r.key === 'tokensPer30Days')).toMatchObject({ used: 100 + 160 + 100 + 100 });
  });

  it('is seeded without a request that is recorded first, then inserted (how the backend records)', async () => {
    const { counter, insert } = await setup({ tokensPerDay: 1000 });
    counter.record('ada', { tokens: 100, costUsd: null });
    await insert('ada', at('2026-11-02T10:00:00Z'));
    expect((await counter.status('ada')).rows[0]).toMatchObject({ used: 100 });
    counter.record('ada', { tokens: 100, costUsd: null });
    expect((await counter.status('ada')).rows[0]).toMatchObject({ used: 200 });
  });

  it('ignores people without an account id (a local backend that was never signed in)', async () => {
    const { counter } = await setup({ tokensPerDay: 1 });
    counter.record(null, { tokens: 100, costUsd: null });
    expect(await counter.admit(null)).toHaveProperty('release');
  });
});

describe('the daily window', () => {
  it('refuses at the limit with its name, the UTC reset time and who to ask, and lets requests through after midnight UTC', async () => {
    const { counter, clock } = await setup({ tokensPerDay: 250 });
    counter.record('ada', { tokens: 200, costUsd: null });
    expect(await refused(counter)).toBeNull();
    counter.record('ada', { tokens: 50, costUsd: null });
    const hit = await refused(counter);
    expect(hit?.error).toMatchObject({ code: 'limit_reached', retryable: false });
    expect(hit?.error?.message).toContain('250 tokens (tokens per day)');
    expect(hit?.error?.message).toContain('at 00:00 UTC (in about 14 hours)');
    expect(hit?.error?.message).toContain('Ask an admin (Grace)');
    expect(hit?.hit.resetsAt).toBe(at('2026-11-03T00:00:00Z'));
    // Somebody else is not affected.
    expect(await refused(counter, 'bob')).toBeNull();
    clock.now = at('2026-11-03T00:00:00Z');
    expect(await refused(counter)).toBeNull();
    expect((await counter.status('ada')).rows[0]).toMatchObject({ used: 0, reached: false });
  });

  it('cuts the day at UTC midnight whatever time zone the server is in', async () => {
    const { counter, clock } = await setup({ tokensPerDay: 100 }, {}, '2026-11-02T23:59:00Z');
    counter.record('ada', { tokens: 100, costUsd: null });
    expect(await refused(counter)).not.toBeNull();
    clock.now = at('2026-11-03T00:00:01Z');
    expect(await refused(counter)).toBeNull();
  });
});

describe('the 30-day window', () => {
  it('is rolling: the oldest day leaves first, and the reset time is when enough has left', async () => {
    const { counter, clock, insert } = await setup({ tokensPer30Days: 500 });
    await insert('ada', at('2026-10-10T12:00:00Z'), { input: 250, output: 0 });
    await insert('ada', at('2026-10-20T12:00:00Z'), { input: 200, output: 0 });
    await insert('ada', at('2026-11-02T08:00:00Z'), { input: 100, output: 0 });
    const hit = await refused(counter);
    // 550 used; Oct 10 leaves the window 30 days later (Nov 9, 00:00 UTC) and takes it to 300.
    expect(hit?.hit).toMatchObject({ key: 'tokensPer30Days', used: 550, max: 500, resetsAt: at('2026-11-09T00:00:00Z') });
    expect(hit?.error?.message).toContain('on Nov 9 at 00:00 UTC (in about 7 days)');
    clock.now = at('2026-11-09T00:00:00Z');
    expect(await refused(counter)).toBeNull();
  });

  it('tells the person the latest of several limits they are over', async () => {
    const rolling = await setup({ tokensPerDay: 100, tokensPer30Days: 150 });
    await rolling.insert('ada', at('2026-10-20T12:00:00Z'), { input: 100, output: 0 });
    rolling.counter.record('ada', { tokens: 100, costUsd: null });
    // The day resets tonight, the 30 days only when Oct 20 leaves: that is the one that matters.
    expect((await refused(rolling.counter))?.hit).toMatchObject({ key: 'tokensPer30Days', resetsAt: at('2026-11-19T00:00:00Z') });
  });
});

describe('cost limits', () => {
  it('count priced requests only and say how many had no price', async () => {
    const { counter } = await setup({ costUsdPerDay: 1 });
    counter.record('ada', { tokens: 1_000_000, costUsd: null });
    counter.record('ada', { tokens: 10, costUsd: 0.6 });
    expect(await refused(counter)).toBeNull();
    const status = await counter.status('ada');
    expect(status.rows[0]).toMatchObject({ key: 'costUsdPerDay', used: 0.6, max: 1 });
    expect(status.unpriced).toBe(1);
    counter.record('ada', { tokens: 10, costUsd: 0.4 });
    const hit = await refused(counter);
    expect(hit?.error?.message).toContain('$1.00 (cost per day)');
    expect(hit?.error?.message).toContain('Only requests to models with a price count');
  });

  it('leaves a model without a price to the token limits', async () => {
    const { counter } = await setup({ costUsdPerDay: 0.01, tokensPerDay: 500 });
    counter.record('ada', { tokens: 400, costUsd: null });
    expect(await refused(counter)).toBeNull();
    counter.record('ada', { tokens: 100, costUsd: null });
    expect((await refused(counter))?.hit.key).toBe('tokensPerDay');
  });
});

describe('the request limit and requests running together', () => {
  it('counts the last hour and lets the oldest request age out', async () => {
    const { counter, clock } = await setup({ requestsPerHour: 2 });
    counter.record('ada', { tokens: 1, costUsd: null });
    clock.now += 20 * 60_000;
    counter.record('ada', { tokens: 1, costUsd: null });
    const hit = await refused(counter);
    expect(hit?.hit).toMatchObject({ used: 2, max: 2, resetsAt: at('2026-11-02T11:00:00Z') });
    expect(hit?.error?.message).toContain('at 11:00 UTC (in 40 minutes)');
    clock.now = at('2026-11-02T11:00:00Z') + 1;
    expect(await refused(counter)).toBeNull();
  });

  it('counts requests that are still under way, so runs started together cannot all slip under it', async () => {
    const { counter } = await setup({ requestsPerHour: 3 });
    const starts = await Promise.all(Array.from({ length: 5 }, () => counter.admit('ada')));
    expect(starts.filter((s) => !s.error)).toHaveLength(3);
    const blocked = starts.find((s) => s.error);
    // Nothing has finished, so there is no time to give: the reset waits on the running requests.
    expect(blocked?.error?.message).toContain('when your running requests finish');
    for (const s of starts) if (!s.error) s.release();
    expect(await refused(counter)).toBeNull();
  });

  it('gives a place back once, and only for the request that held it', async () => {
    const { counter } = await setup({ requestsPerHour: 1 });
    const first = await counter.admit('ada');
    if (first.error) throw new Error('first request refused');
    expect(await refused(counter)).not.toBeNull();
    first.release();
    first.release();
    expect(await refused(counter)).toBeNull();
    const again = await counter.admit('ada');
    if (again.error) throw new Error('refused');
    // A second release of the first must not have freed this one.
    first.release();
    expect(await refused(counter)).not.toBeNull();
    again.release();
  });

  it('lets a request nobody asked for through without holding a place, so it never makes the person’s own turn wait', async () => {
    const { counter } = await setup({ requestsPerHour: 1 });
    expect(await counter.check('ada')).toBeNull();
    expect(await counter.check('ada')).toBeNull();
    expect(await refused(counter)).toBeNull();
    counter.record('ada', { tokens: 1, costUsd: null });
    expect((await counter.check('ada'))?.code).toBe('limit_reached');
    expect(await counter.check(null)).toBeNull();
  });

  it('sums the tokens of runs recorded in any order, whichever session they came from', async () => {
    const { counter } = await setup({ tokensPerDay: 300 });
    await Promise.all([1, 2, 3].map(async () => counter.record('ada', { tokens: 100, costUsd: null })));
    expect(await refused(counter)).not.toBeNull();
  });
});

describe('overrides', () => {
  it('lets one person be exempt from every limit', async () => {
    const { counter } = await setup({ tokensPerDay: 10, requestsPerHour: 1 }, { ada: { exempt: true } });
    counter.record('ada', { tokens: 1000, costUsd: null });
    counter.record('bob', { tokens: 1000, costUsd: null });
    expect(await refused(counter, 'ada')).toBeNull();
    expect(await refused(counter, 'bob')).not.toBeNull();
    expect(await counter.status('ada')).toMatchObject({ exempt: true, rows: [] });
  });

  it('raises, lowers or lifts a single limit for one person and leaves the rest to the system', async () => {
    const { counter } = await setup(
      { tokensPerDay: 100, requestsPerHour: 2 },
      { ada: { tokensPerDay: 1000 }, bob: { requestsPerHour: null, tokensPerDay: 50 } },
    );
    counter.record('ada', { tokens: 500, costUsd: null });
    counter.record('bob', { tokens: 60, costUsd: null });
    counter.record('bob', { tokens: 1, costUsd: null });
    counter.record('bob', { tokens: 1, costUsd: null });
    expect(await refused(counter, 'ada')).toBeNull();
    expect((await refused(counter, 'bob'))?.hit.key).toBe('tokensPerDay');
    expect((await counter.status('bob')).rows.map((r) => [r.key, r.max, r.overridden])).toEqual([['tokensPerDay', 50, true]]);
    expect((await counter.status('ada')).rows.map((r) => [r.key, r.max, r.overridden])).toEqual([['tokensPerDay', 1000, true], ['requestsPerHour', 2, undefined]]);
  });

  it('gives a person with an override a limit when the system has none', async () => {
    const { counter } = await setup({}, { ada: { tokensPerDay: 10 } });
    counter.record('ada', { tokens: 10, costUsd: null });
    expect(await refused(counter, 'ada')).not.toBeNull();
    expect(await refused(counter, 'bob')).toBeNull();
  });

  it('follows a change of the settings at once', async () => {
    const { counter, system } = await setup({ tokensPerDay: 100 });
    counter.record('ada', { tokens: 100, costUsd: null });
    expect(await refused(counter)).not.toBeNull();
    system.limits = { tokensPerDay: 200 };
    expect(await refused(counter)).toBeNull();
    system.limits = {};
    expect((await counter.status('ada')).rows).toEqual([]);
  });
});

describe('warnings', () => {
  it('warn once at 80% of a daily limit, again the next day, and not at all at the limit', async () => {
    const { counter, clock } = await setup({ tokensPerDay: 1000 });
    counter.record('ada', { tokens: 700, costUsd: null });
    expect(await counter.warnings('ada')).toEqual([]);
    counter.record('ada', { tokens: 100, costUsd: null });
    const [warning] = await counter.warnings('ada');
    expect(warning).toMatchObject({ key: 'tokensPerDay', used: 800, max: 1000 });
    expect(warning?.message).toBe('You’ve used 80% of your limit of 1,000 tokens (tokens per day). It resets at 00:00 UTC (in about 14 hours).');
    counter.record('ada', { tokens: 50, costUsd: null });
    expect(await counter.warnings('ada')).toEqual([]);
    clock.now = at('2026-11-03T09:00:00Z');
    counter.record('ada', { tokens: 900, costUsd: null });
    expect(await counter.warnings('ada')).toHaveLength(1);
    counter.record('ada', { tokens: 100, costUsd: null });
    expect(await counter.warnings('ada')).toEqual([]);
  });

  it('warn again for a rolling limit only after usage fell below the line', async () => {
    const { counter, clock } = await setup({ requestsPerHour: 5 });
    for (let i = 0; i < 4; i++) counter.record('ada', { tokens: 1, costUsd: null });
    expect(await counter.warnings('ada')).toHaveLength(1);
    counter.record('ada', { tokens: 1, costUsd: null });
    expect(await counter.warnings('ada')).toEqual([]);
    clock.now += 2 * HOUR;
    expect(await counter.warnings('ada')).toEqual([]);
    for (let i = 0; i < 4; i++) counter.record('ada', { tokens: 1, costUsd: null });
    expect(await counter.warnings('ada')).toHaveLength(1);
  });
});

describe('describing a reset', () => {
  it('names the time in UTC and how far away it is', () => {
    const now = at('2026-11-02T10:00:00Z');
    expect(describeReset(now + 5 * 60_000, now)).toBe('at 10:05 UTC (in 5 minutes)');
    expect(describeReset(now + 60_000, now)).toBe('at 10:01 UTC (in 1 minute)');
    expect(describeReset(at('2026-11-03T00:00:00Z'), now)).toBe('at 00:00 UTC (in about 14 hours)');
    expect(describeReset(now + 5 * DAY, now)).toBe('on Nov 7 at 10:00 UTC (in about 5 days)');
    expect(describeReset(null, now)).toBe('when your running requests finish');
  });
});
