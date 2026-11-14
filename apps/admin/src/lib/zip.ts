/**
 * Reports as a zip, built here in the browser (fflate): per report a folder `<id>/` with report.json, chat.json, the
 * screenshots as stored, and report.md, a summary a person (or an agent) can read without the panel.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { DetailResponse, FullRow, ReportChat, ReportEnvelope } from '../types';
import { api, apiBytes } from './api';
import { bytes, dateTime, mhz, osLabel, statusLabel } from './format';

export interface Bundle {
  row: FullRow;
  report: ReportEnvelope | null;
  chat: ReportChat | null;
  files: { name: string; bytes: Uint8Array }[];
}

/** A fence longer than any run of backticks in `text`. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

const line = (label: string, value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? null : `- **${label}:** ${value}`;

type System = NonNullable<NonNullable<ReportEnvelope['diagnostics']>['client']>;
function systemLines(s: System): string[] {
  const hw = s.hardware ?? {};
  const out = [
    line('OS', [s.os.name ?? osLabel(s.os.platform), s.os.release, s.os.arch].filter(Boolean).join(', ')),
    line('Locale', [s.os.locale, s.os.timeZone].filter(Boolean).join(', ')),
    line('Model', hw.model),
    line(
      'CPU',
      hw.cpu ? `${hw.cpu.model}, ${hw.cpu.cores} cores${hw.cpu.speedMHz ? `, ${mhz(hw.cpu.speedMHz)}` : ''}` : null,
    ),
    line(
      'Memory',
      hw.memory
        ? `${bytes(hw.memory.totalBytes)}${hw.memory.freeBytes != null ? ` (${bytes(hw.memory.freeBytes)} free)` : ''}`
        : null,
    ),
    line('Disk', hw.disk ? `${bytes(hw.disk.freeBytes)} free of ${bytes(hw.disk.totalBytes)}` : null),
    ...(hw.gpus ?? []).map((g) =>
      line(
        'GPU',
        [g.name, g.vramBytes ? `${bytes(g.vramBytes)} VRAM` : null, g.driver ? `driver ${g.driver}` : null]
          .filter(Boolean)
          .join(', '),
      ),
    ),
    ...(hw.displays ?? []).map((d) =>
      line(
        'Display',
        `${d.width}×${d.height} @${d.scale}x${d.refreshHz ? `, ${d.refreshHz} Hz` : ''}${d.primary ? ', primary' : ''}`,
      ),
    ),
    line(
      'Runtime',
      Object.entries(s.runtime ?? {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k} ${v}`)
        .join(', '),
    ),
    line('Container', s.container ? 'yes' : null),
  ];
  return out.filter((l): l is string => l !== null);
}

/** The readable summary in each report's folder. */
export function reportMarkdown(
  row: FullRow,
  report: ReportEnvelope | null,
  chat: ReportChat | null,
  files: string[] = [],
): string {
  const parts: string[] = [`# ${row.title}`, ''];
  const facts = [
    line('Id', row.id),
    line('Kind', row.kind === 'issue' ? 'Issue' : 'Feature request'),
    line('Status', statusLabel(row.status)),
    line('Labels', row.labels.join(', ')),
    line('Received', `${dateTime(row.receivedAt)} (${new Date(row.receivedAt).toISOString()})`),
    line('Atelier', [row.version, report?.app.channel, row.mode, row.surface].filter(Boolean).join(', ')),
    line('System', row.os ? [row.osName ?? osLabel(row.os), row.arch].filter(Boolean).join(', ') : null),
    line('Contact', row.contact),
    line('Scrubbed by the collector', row.scrubbed ? `${row.scrubbed} secret${row.scrubbed === 1 ? '' : 's'}` : null),
  ];
  parts.push(...facts.filter((l): l is string => l !== null), '', '## Description', '', row.description, '');
  if (row.note) parts.push('## Note', '', row.note, '');
  const d = report?.diagnostics;
  if (d) {
    parts.push('## Diagnostics', '');
    const app = report.app;
    parts.push(
      '### Atelier',
      '',
      ...[
        line('Version', app.version),
        line('Channel', app.channel),
        line('Mode', app.mode),
        line('Surface', app.surface),
        line('Server version', app.serverVersion),
        line('Window', app.window ? `${app.window.width}×${app.window.height} @${app.window.ratio}x` : null),
        line('Theme', app.theme),
        line('Language', app.language),
      ].filter((l): l is string => l !== null),
      '',
    );
    const same = app.mode === 'desktop-local' && d.client && d.backend;
    if (d.client) parts.push(same ? '### This computer' : '### Client', '', ...systemLines(d.client), '');
    if (d.backend && !same) parts.push(`### Backend (${d.backend.kind})`, '', ...systemLines(d.backend), '');
    if (d.backend?.dataBytes != null || d.backend?.blobBytes != null)
      parts.push(line('Data', `${bytes(d.backend.dataBytes)} database, ${bytes(d.backend.blobBytes)} files`)!, '');
    const providers = [
      ...(d.providers ?? []).map((p) => ({ ...p, image: false })),
      ...(d.imageProviders ?? []).map((p) => ({ ...p, image: true })),
    ];
    if (providers.length) {
      parts.push('### Providers', '', '| Type | Host | Enabled | Key | Models | Status |', '|---|---|---|---|---|---|');
      const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      for (const p of providers) {
        const status = p.status
          ? p.status.ok
            ? `ok${p.status.version ? ` ${p.status.version}` : ''}${p.status.latencyMs != null ? `, ${Math.round(p.status.latencyMs)} ms` : ''}`
            : `error: ${p.status.error ?? ''}`
          : '';
        parts.push(
          `| ${cell(p.type)}${p.image ? ' (images)' : ''} | ${cell(p.host)} | ${p.enabled ? 'yes' : 'no'} | ${p.keySet ? 'set' : '–'} | ${p.models?.length ?? p.status?.modelCount ?? ''} | ${cell(status)} |`,
        );
      }
      parts.push('');
    }
    for (const inf of d.inference ?? []) {
      parts.push(`### ${inf.kind} at ${inf.host}${inf.version ? ` (${inf.version})` : ''}`, '');
      if (inf.error) parts.push(`Error: ${inf.error}`, '');
      for (const m of inf.loaded ?? [])
        parts.push(
          `- Loaded: ${m.name}${m.vramBytes ? `, ${bytes(m.vramBytes)} VRAM` : ''}${m.sizeBytes ? `, ${bytes(m.sizeBytes)}` : ''}${m.contextLength ? `, context ${m.contextLength}` : ''}`,
        );
      if (inf.models?.length) parts.push(`- Installed: ${inf.models.map((m) => m.name).join(', ')}`);
      for (const dev of inf.devices ?? [])
        parts.push(
          `- Device: ${dev.name}${dev.vramBytes ? `, ${bytes(dev.vramBytes)} VRAM` : ''}${dev.vramFreeBytes != null ? ` (${bytes(dev.vramFreeBytes)} free)` : ''}`,
        );
      parts.push('');
    }
    if (d.connectors?.length)
      parts.push(
        '### Connectors',
        '',
        ...d.connectors.map(
          (c) =>
            `- ${c.type}: ${c.status}${c.tools != null ? `, ${c.tools} tools` : ''}${c.error ? ` (${c.error})` : ''}`,
        ),
        '',
      );
    if (d.computerUse)
      parts.push(
        '### Computer use',
        '',
        `- Available: ${d.computerUse.available ? 'yes' : 'no'}${d.computerUse.enabled != null ? `, enabled: ${d.computerUse.enabled ? 'yes' : 'no'}` : ''}${d.computerUse.helper ? `, helper ${d.computerUse.helper}` : ''}`,
        '',
      );
    if (d.notes && Object.keys(d.notes).length)
      parts.push('### Notes', '', ...Object.entries(d.notes).map(([k, v]) => `- ${k}: ${v}`), '');
    if (d.lastError)
      parts.push('### Last error', '', `${dateTime(d.lastError.at)}`, '', fence(d.lastError.message), '');
    if (d.log?.length) parts.push(`### Log (last ${d.log.length} lines)`, '', fence(d.log.join('\n')), '');
  }
  if (chat) {
    const s = chat.session;
    parts.push(
      '## Chat',
      '',
      `${s.title} (${s.mode}${s.model ? `, ${s.model}` : ''}${s.provider ? ` via ${s.provider}` : ''}): ${chat.coverage.total} messages, ${chat.coverage.included} included${chat.coverage.omitted.length ? `, ${chat.coverage.omitted.map((o) => `${o.from}–${o.to}`).join(', ')} left out` : ''}. The messages are in chat.json.`,
      '',
    );
  }
  if (files.length) parts.push('## Screenshots', '', ...files.map((f) => `- ${f}`), '');
  return parts.join('\n');
}

/** One report with everything the zip holds. */
export async function fetchBundle(id: string): Promise<Bundle> {
  const detail = await api<DetailResponse>(`/api/reports/${id}`);
  const [chat, files] = await Promise.all([
    detail.row.hasChat ? api<ReportChat>(`/api/reports/${id}/chat`).catch(() => null) : Promise.resolve(null),
    Promise.all(
      detail.files.map(async (f) => ({ name: f.name, bytes: await apiBytes(`/api/reports/${id}/files/${f.name}`) })),
    ),
  ]);
  return {
    row: detail.row,
    report: detail.report,
    chat,
    files: files.filter((f): f is { name: string; bytes: Uint8Array } => f.bytes !== null),
  };
}

export function buildZip(bundles: Bundle[]): Uint8Array {
  const files: Zippable = {};
  for (const b of bundles) {
    const dir = b.row.id;
    files[`${dir}/report.md`] = strToU8(
      reportMarkdown(
        b.row,
        b.report,
        b.chat,
        b.files.map((f) => f.name),
      ),
    );
    files[`${dir}/report.json`] = strToU8(JSON.stringify(b.report, null, 2));
    if (b.chat) files[`${dir}/chat.json`] = strToU8(JSON.stringify(b.chat, null, 2));
    // Pictures are compressed already.
    for (const f of b.files) files[`${dir}/${f.name}`] = [f.bytes, { level: 0 }];
  }
  return zipSync(files, { level: 6 });
}

/** Fetches the reports a few at a time, telling how far it got, and zips them. */
export async function zipReports(
  ids: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const bundles: Bundle[] = new Array(ids.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      bundles[i] = await fetchBundle(ids[i]!);
      onProgress?.(++done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  return buildZip(bundles);
}

export function saveFile(name: string, data: Uint8Array, type = 'application/zip') {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
