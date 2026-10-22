/**
 * Time: the current date, time and time zone. The date at the start of a session is in `<env>` and goes stale in a long
 * one, and the time of day is told nowhere else; this answers without a shell or a web search.
 */
import { localDate } from '../prompts/env.ts';
import { textOutput, type DescribeContext, type Tool } from './types.ts';

export interface TimeDeps {
  now(): Date;
  /** The person's time zone (an IANA name). */
  timeZone(): string;
}

function describe({ tier }: DescribeContext): string {
  if (tier === 'compact') return 'Returns the current date and time.';
  return 'Returns the current date, time and time zone. Use it when the time matters: how long ago something happened, how long a task has run, a deadline or "later today". The date in the environment block is the start of the session and can be days old.';
}

/** `Wednesday, 2026-10-21 09:14:07 (Europe/Berlin, UTC+02:00); UTC 2026-10-21T07:14:07Z`. */
export function formatNow(now: Date, timeZone: string): string {
  const { long } = localDate(now, timeZone);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now);
  const offset = /GMT([+-][\d:]+)?/.exec(new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).format(now))?.[1];
  const utc = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${long} ${clock} (${timeZone}, UTC${offset ?? '+00:00'}); UTC ${utc}`;
}

export function createTimeTool(deps: TimeDeps): Tool<Record<string, never>> {
  return {
    name: 'Time',
    readOnly: true,
    description: describe,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    compactExample: {},
    async run() {
      return textOutput(formatNow(deps.now(), deps.timeZone()));
    },
  };
}
