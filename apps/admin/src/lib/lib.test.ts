import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { niceTicks } from '../components/charts';
import { lastErrorLine } from '../pages/report/LogsTab';
import type { FullRow, ReportChat, ReportEnvelope } from '../types';
import { bytes, compareVersions, daysBetween, mhz, relative, statusLabel } from './format';
import { renderMarkdown, safeHref } from './markdown';
import { platformLabel } from './platforms';
import { buildZip, reportMarkdown } from './zip';

describe('markdown from reports', () => {
  it('shows raw HTML as text and never makes script, handlers or javascript: links', () => {
    const nasty = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '[click](javascript:alert(1))',
      '[click](JaVaScRiPt:alert(1))',
      '[data](data:text/html;base64,PHNjcmlwdD4=)',
      '<javascript:alert(1)>',
      '![pic](https://tracker.example/p.png)',
      '<iframe src="https://evil.example"></iframe>',
      '<svg onload=alert(1)>',
      '[x](https://ok.example "a\\" onmouseover=\\"alert(1)")',
      '```js"><script>alert(1)</script>\ncode\n```',
      '<details open ontoggle=alert(1)>',
    ];
    for (const input of nasty) {
      const html = renderMarkdown(input);
      expect(html, input).not.toMatch(/<(?:script|img|iframe|svg|details|object|embed|style)\b/i);
      // The attributes of the real tags (escaped text, and attribute values, may say anything).
      const attributes = [...html.matchAll(/<[a-z][a-z0-9]*((?:\s+[a-z-]+="[^"]*")*)\s*\/?>/gi)].flatMap((tag) =>
        [...tag[1]!.matchAll(/([a-z-]+)="([^"]*)"/gi)].map((a) => [a[1]!.toLowerCase(), a[2]!] as const),
      );
      expect(html.replace(/<[a-z][a-z0-9]*(?:\s+[a-z-]+="[^"]*")*\s*\/?>|<\/[a-z][a-z0-9]*>/gi, ''), input).not.toMatch(
        /[<>"]/,
      );
      for (const [name, value] of attributes) {
        expect(name, input).toMatch(/^(?:href|title|target|rel|class)$/);
        if (name === 'href') expect(value, input).toMatch(/^(?:https?|mailto):/);
      }
    }
    expect(renderMarkdown('<b>bold</b>')).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('keeps ordinary markdown and safe links', () => {
    const html = renderMarkdown(
      '# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n\n[docs](https://docs.atelierhq.dev/x?y=1)',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain(
      '<a href="https://docs.atelierhq.dev/x?y=1" target="_blank" rel="noopener noreferrer nofollow">docs</a>',
    );
    expect(renderMarkdown('![a chart](https://x.example/c.png)')).toContain('[picture: a chart]');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('/relative')).toBeNull();
    expect(safeHref(' javascript:x')).toBeNull();
  });
});

describe('formatting', () => {
  it('uses decimal units and humane times', () => {
    expect(bytes(48_000_000_000)).toBe('48 GB');
    expect(bytes(1_234_567)).toBe('1.2 MB');
    expect(bytes(950)).toBe('950 B');
    expect(bytes(25_769_803_776)).toBe('25.8 GB');
    expect(mhz(3504)).toBe('3,504 MHz');
    const now = Date.parse('2026-11-14T12:00:00Z');
    expect(relative(now - 30_000, now)).toBe('just now');
    expect(relative(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relative(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relative(now - 30 * 3_600_000, now)).toBe('yesterday');
    expect(statusLabel('wont-fix')).toBe('Won’t fix');
    expect(statusLabel('in-progress')).toBe('In progress');
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(['0.8.1', '0.10.0', '0.9.0-beta.1', '0.9.0'].sort((a, b) => compareVersions(b, a))).toEqual([
      '0.10.0',
      '0.9.0',
      '0.9.0-beta.1',
      '0.8.1',
    ]);
    expect(platformLabel('cli-linux-arm64')).toBe('Terminal app, Linux ARM64');
    expect(platformLabel('mac-arm64')).toBe('macOS, Apple silicon');
  });

  it('picks clean axis ticks', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
  });

  it('finds the last error in a log', () => {
    const log = ['start', 'Error: first', 'ok', 'TypeError: fetch failed at x', 'later'];
    expect(lastErrorLine(log, 'TypeError: fetch failed\n  at y')).toBe(3);
    expect(lastErrorLine(log)).toBe(3);
    expect(lastErrorLine(['fine'])).toBe(-1);
  });
});

const row: FullRow = {
  id: 'I-7F3K2Q',
  kind: 'issue',
  title: 'Chat stops after the first reply',
  status: 'triaged',
  labels: ['chat'],
  version: '0.8.2',
  surface: 'desktop',
  mode: 'desktop-local',
  os: 'darwin',
  osName: 'macOS 26.1',
  arch: 'arm64',
  hasDiagnostics: true,
  hasChat: true,
  screenshots: 1,
  hasContact: true,
  bytes: 1000,
  scrubbed: 0,
  receivedAt: Date.parse('2026-11-14T10:00:00Z'),
  updatedAt: Date.parse('2026-11-14T10:00:00Z'),
  seenAt: null,
  description: 'It stops. ```weird``` fences',
  contact: 'me@example.com',
  note: 'Ask for the log.',
};
const report = {
  v: 1,
  kind: 'issue',
  title: row.title,
  description: row.description,
  app: { version: '0.8.2', surface: 'desktop', mode: 'desktop-local', channel: 'stable' },
  diagnostics: {
    collectedAt: 1,
    client: {
      os: { platform: 'darwin', name: 'macOS 26.1', arch: 'arm64' },
      hardware: { cpu: { model: 'Apple M4 Pro', cores: 14 }, memory: { totalBytes: 48e9 } },
      runtime: {},
    },
    backend: { kind: 'desktop', os: { platform: 'darwin' }, hardware: {}, runtime: { node: '24.11.0' } },
    providers: [
      {
        type: 'ollama',
        host: 'localhost:11434',
        enabled: true,
        keySet: false,
        status: { ok: true, version: '0.13.2' },
      },
    ],
    log: ['a line with ``` inside'],
    lastError: { message: 'boom', at: 1 },
  },
  attachments: { chat: true, screenshots: [{ name: 'shot0', mime: 'image/png', width: 4, height: 4, bytes: 3 }] },
  createdAt: 1,
} as unknown as ReportEnvelope;
const chat = {
  session: { mode: 'code', title: 'Fix the composer', status: 'idle', createdAt: 1, updatedAt: 2, model: 'qwen3:30b' },
  coverage: { total: 862, included: 2, omitted: [{ from: 12, to: 840 }], shortened: 0 },
  messages: [],
} as unknown as ReportChat;

describe('the zip', () => {
  it('summarizes a report readably, as one computer in desktop-local mode', () => {
    const md = reportMarkdown(row, report, chat, ['shot0.png']);
    expect(md).toMatch(/^# Chat stops after the first reply/);
    expect(md).toContain('- **Id:** I-7F3K2Q');
    expect(md).toContain('- **Status:** Triaged');
    expect(md).toContain('### This computer');
    expect(md).not.toContain('### Backend');
    expect(md).toContain('- **CPU:** Apple M4 Pro, 14 cores');
    expect(md).toContain('- **Memory:** 48 GB');
    expect(md).toContain('| ollama | localhost:11434 | yes | – |');
    expect(md).toContain('````\na line with ``` inside\n````');
    expect(md).toContain('12–840 left out');
    expect(md).toContain('## Note\n\nAsk for the log.');
  });

  it('puts each report in its own folder with its files', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e]);
    const zip = buildZip([
      { row, report, chat, files: [{ name: 'shot0.png', bytes: png }] },
      { row: { ...row, id: 'F-000001', hasChat: false }, report, chat: null, files: [] },
    ]);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      'F-000001/report.json',
      'F-000001/report.md',
      'I-7F3K2Q/chat.json',
      'I-7F3K2Q/report.json',
      'I-7F3K2Q/report.md',
      'I-7F3K2Q/shot0.png',
    ]);
    expect(files['I-7F3K2Q/shot0.png']).toEqual(png);
    expect(JSON.parse(strFromU8(files['I-7F3K2Q/report.json']!)).title).toBe(row.title);
  });
});
