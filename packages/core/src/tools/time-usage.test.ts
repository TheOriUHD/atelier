import { describe, expect, it } from 'vitest';
import { createTimeTool, formatNow } from './time.ts';
import { createUsageTool, formatUsage, untilReset } from './usage.ts';
import type { ToolContext } from './types.ts';

const ctx = { sessionId: 's1' } as ToolContext;
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('');

describe('Time', () => {
  it('says the date, time, zone and offset, and the UTC time', async () => {
    const now = new Date('2026-10-21T07:14:07Z');
    expect(formatNow(now, 'Europe/Berlin')).toBe('Wednesday, 2026-10-21 09:14:07 (Europe/Berlin, UTC+02:00); UTC 2026-10-21T07:14:07Z');
    expect(formatNow(now, 'America/New_York')).toBe('Wednesday, 2026-10-21 03:14:07 (America/New_York, UTC-04:00); UTC 2026-10-21T07:14:07Z');
    expect(formatNow(now, 'UTC')).toBe('Wednesday, 2026-10-21 07:14:07 (UTC, UTC+00:00); UTC 2026-10-21T07:14:07Z');
    const tool = createTimeTool({ now: () => now, timeZone: () => 'Europe/Berlin' });
    expect(tool.readOnly).toBe(true);
    expect(text(await tool.run({}, ctx))).toMatch(/^Wednesday, 2026-10-21 09:14:07/);
  });
});

describe('Usage', () => {
  const now = Date.parse('2026-10-21T07:00:00Z');

  it("lists a plan's windows with how much is used and how long each has left", () => {
    const out = formatUsage(
      {
        provider: 'ChatGPT Plan',
        plan: 'Pro 100',
        windows: [
          { minutes: 10_080, usedPercent: 37.6, resetsAt: now + (2 * 24 + 4) * 3_600_000 },
          { minutes: 300, usedPercent: 12, resetsAt: now + 190 * 60_000 },
        ],
      },
      now,
    );
    expect(out).toBe(
      ['ChatGPT Plan (Pro 100), usage limits as last reported:', '- Weekly: 38% used, resets in 2 d 4 h (2026-10-23T11:00:00Z)', '- 5-hour: 12% used, resets in 3 h 10 min (2026-10-21T10:10:00Z)'].join('\n'),
    );
  });

  it('says so before the plan has reported anything, and gives a priced API its cost', () => {
    expect(formatUsage({ provider: 'ChatGPT Plan', windows: [] }, now)).toMatch(/no usage figures yet/);
    expect(formatUsage({ provider: 'Anthropic', cost: { session: 0.4321, today: 3, week: null, unpriced: true } }, now)).toBe(
      'Anthropic, cost in US dollars: this session $0.43, today $3.00, last 7 days not priced.\nSome requests have no known price and are not counted.',
    );
    expect(untilReset(25 * 60_000)).toBe('25 min');
    expect(untilReset(-5)).toBe('now');
  });

  it('reports nothing for a provider without figures', async () => {
    const tool = createUsageTool({ report: async () => null, now: () => now });
    expect(text(await tool.run({}, ctx))).toBe('This provider reports no limits or costs.');
  });
});
