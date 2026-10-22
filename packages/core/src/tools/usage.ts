/**
 * Usage: how much of the person's plan limits or API spend is used, for the provider the session runs on: a ChatGPT
 * plan's 5-hour and weekly windows with the time left in each, or what a priced API has cost this session, today and
 * over the last week. Offered only where there is something to report (not for local models).
 */
import { textOutput, type DescribeContext, type Tool } from './types.ts';

export interface UsageReport {
  /** The provider as the person knows it ("ChatGPT Plan", "Anthropic"). */
  provider: string;
  /** A subscription's plan ("Pro 200"). */
  plan?: string;
  /** A subscription's windows as the provider last reported them; `resetsAt` in ms. */
  windows?: { minutes: number | null; usedPercent: number; resetsAt: number | null }[];
  /** A priced API's spend in US dollars; null where nothing was priced. `unpriced`: some requests have no price. */
  cost?: { session: number | null; today: number | null; week: number | null; unpriced: boolean };
}

export interface UsageDeps {
  /** The report for the session's current model's provider. */
  report(sessionId: string): Promise<UsageReport | null>;
  now(): number;
}

function describe({ tier }: DescribeContext): string {
  if (tier === 'compact') return 'Shows plan limits or API cost used so far.';
  return [
    "Shows how much of the person's plan limits or API spend is used on the provider this session runs on: a subscription's windows (5-hour, weekly) with the share used and the time until each resets, or what a priced API has cost this session, today and over the last 7 days.",
    'Use it before long or parallel work (many sub-agents, large searches) when the person may be close to a limit or a budget, or when they ask. Tell them when a window is nearly used instead of carrying on silently.',
  ].join('\n');
}

const windowName = (minutes: number | null): string =>
  minutes === null || minutes <= 0 ? 'Usage limit' : minutes === 10_080 ? 'Weekly' : minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;

/** "2 d 4 h", "3 h 10 min", "25 min". */
export function untilReset(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return `${d} d${h ? ` ${h} h` : ''}`;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  return `${m} min`;
}

const dollars = (n: number | null): string => (n === null ? 'not priced' : n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);

export function formatUsage(report: UsageReport, now: number): string {
  const head = `${report.provider}${report.plan ? ` (${report.plan})` : ''}`;
  const lines: string[] = [];
  if (report.windows) {
    if (report.windows.length === 0) lines.push(`${head}: no usage figures yet. The plan reports them with each reply, so ask again after the next message.`);
    else {
      lines.push(`${head}, usage limits as last reported:`);
      for (const w of report.windows) {
        const left = w.resetsAt === null ? '' : `, resets in ${untilReset(w.resetsAt - now)} (${new Date(w.resetsAt).toISOString().replace(/\.\d{3}Z$/, 'Z')})`;
        lines.push(`- ${windowName(w.minutes)}: ${Math.round(w.usedPercent)}% used${left}`);
      }
    }
  }
  if (report.cost) {
    const { session, today, week, unpriced } = report.cost;
    lines.push(`${head}, cost in US dollars: this session ${dollars(session)}, today ${dollars(today)}, last 7 days ${dollars(week)}.`);
    if (unpriced) lines.push('Some requests have no known price and are not counted.');
  }
  return lines.join('\n') || `${head}: nothing to report.`;
}

export function createUsageTool(deps: UsageDeps): Tool<Record<string, never>> {
  return {
    name: 'Usage',
    readOnly: true,
    description: describe,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    compactExample: {},
    async run(_input, ctx) {
      const report = await deps.report(ctx.sessionId);
      if (!report) return textOutput('This provider reports no limits or costs.');
      return textOutput(formatUsage(report, deps.now()));
    },
  };
}
