/**
 * The diagnostics: the app, the computers, providers, local inference, connectors, computer use and notes. In
 * desktop-local mode the client and the backend are the same computer, so they show as one "This computer" card.
 */
import { CircleCheck, CircleX, Cpu, HardDrive, MemoryStick, Monitor, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Card, Facts } from '../../components/ui';
import { bytes, dateTime, duration, mhz, num, osLabel } from '../../lib/format';
import type { ReportEnvelope } from '../../types';

type Diagnostics = NonNullable<ReportEnvelope['diagnostics']>;
type System = NonNullable<Diagnostics['client']>;
type Backend = NonNullable<Diagnostics['backend']>;
type Provider = NonNullable<Diagnostics['providers']>[number];
type Inference = NonNullable<Diagnostics['inference']>[number];

const yes = (v: boolean | undefined) => (v === undefined ? null : v ? 'Yes' : 'No');

/** The client's view and the backend's of one computer, merged: the client's first, the backend's to fill in. */
function merge(client: System, backend: Backend): System & Partial<Backend> {
  return {
    ...backend,
    ...client,
    os: { ...backend.os, ...stripUndefined(client.os) },
    hardware: { ...backend.hardware, ...stripUndefined(client.hardware ?? {}) },
    runtime: { ...backend.runtime, ...stripUndefined(client.runtime ?? {}) },
    kind: backend.kind,
    dataBytes: backend.dataBytes,
    blobBytes: backend.blobBytes,
    counts: backend.counts,
    container: backend.container ?? client.container,
    uptimeSeconds: backend.uptimeSeconds ?? client.uptimeSeconds,
  };
}
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-caption font-medium tracking-wide text-fg-muted uppercase">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}

function Computer({
  title,
  system,
  backend,
}: {
  title: string;
  system: System;
  backend?: Partial<Backend> | undefined;
}) {
  const hw = system.hardware ?? {};
  const runtime = Object.entries(system.runtime ?? {}).filter(([, v]) => v);
  return (
    <Card
      title={title}
      actions={backend?.kind && <Badge>{backend.kind === 'server' ? 'Server' : 'Desktop backend'}</Badge>}
    >
      <div className="grid gap-x-10 gap-y-5 @3xl:grid-cols-2">
        <div className="space-y-5">
          <Facts
            rows={[
              ['System', system.os.name ?? osLabel(system.os.platform)],
              ['Release', system.os.release],
              ['Architecture', system.os.arch],
              ['Locale', system.os.locale],
              ['Time zone', system.os.timeZone],
              ['Model', hw.model],
              ['Container', system.container ? 'Yes' : null],
              ['Up for', system.uptimeSeconds != null ? duration(system.uptimeSeconds) : null],
            ]}
          />
          {(hw.cpu || hw.memory || hw.disk) && (
            <Section icon={<Cpu size={13} aria-hidden />} title="Hardware">
              <Facts
                rows={[
                  ['CPU', hw.cpu?.model],
                  ['Cores', hw.cpu ? num(hw.cpu.cores) : null],
                  ['Clock', hw.cpu?.speedMHz ? mhz(hw.cpu.speedMHz) : null],
                  [
                    'Memory',
                    hw.memory
                      ? `${bytes(hw.memory.totalBytes)}${hw.memory.freeBytes != null ? `, ${bytes(hw.memory.freeBytes)} free` : ''}`
                      : null,
                  ],
                  ['Disk', hw.disk ? `${bytes(hw.disk.freeBytes)} free of ${bytes(hw.disk.totalBytes)}` : null],
                ]}
              />
            </Section>
          )}
        </div>
        <div className="space-y-5">
          {hw.gpus && hw.gpus.length > 0 && (
            <Section
              icon={<MemoryStick size={13} aria-hidden />}
              title={hw.gpus.length === 1 ? 'GPU' : `GPUs (${hw.gpus.length})`}
            >
              <ul className="space-y-2">
                {hw.gpus.map((g, i) => (
                  <li key={i} className="rounded-lg bg-bg-sunken px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-footnote">
                      <span className="font-medium">{g.name}</span>
                      {g.vendor && <span className="text-fg-muted">{g.vendor}</span>}
                      <Badge className="ml-auto">{g.source}</Badge>
                    </div>
                    <div className="mt-1 text-caption text-fg-secondary">
                      {[
                        g.vramBytes ? `${bytes(g.vramBytes)} VRAM` : null,
                        g.vramFreeBytes != null ? `${bytes(g.vramFreeBytes)} free` : null,
                        g.driver ? `driver ${g.driver}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'No memory or driver reported'}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {hw.displays && hw.displays.length > 0 && (
            <Section icon={<Monitor size={13} aria-hidden />} title="Displays">
              <ul className="space-y-1 text-footnote">
                {hw.displays.map((d, i) => (
                  <li key={i} className="tabular">
                    {d.width} × {d.height} at {d.scale}×{d.refreshHz ? `, ${d.refreshHz} Hz` : ''}
                    {d.primary && <span className="text-fg-muted">, primary</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {runtime.length > 0 && (
            <Section icon={<HardDrive size={13} aria-hidden />} title="Runtime">
              <Facts rows={runtime.map(([k, v]) => [k.charAt(0).toUpperCase() + k.slice(1), String(v)])} />
            </Section>
          )}
          {backend && (backend.dataBytes != null || backend.blobBytes != null || backend.counts) && (
            <Section icon={<Server size={13} aria-hidden />} title="Atelier's data">
              <Facts
                rows={[
                  ['Database', backend.dataBytes != null ? bytes(backend.dataBytes) : null],
                  ['Files', backend.blobBytes != null ? bytes(backend.blobBytes) : null],
                  ...Object.entries(backend.counts ?? {}).map(([k, v]): [string, ReactNode] => [k, num(v)]),
                ]}
              />
            </Section>
          )}
        </div>
      </div>
    </Card>
  );
}

function Status({ status }: { status: Provider['status'] }) {
  if (!status) return <span className="text-fg-muted">–</span>;
  if (!status.ok)
    return (
      <span className="inline-flex items-start gap-1 text-danger-text">
        <CircleX size={13} className="mt-0.5 shrink-0" aria-label="Failing" />
        <span className="break-words">{status.error ?? 'Failing'}</span>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-success-text">
      <CircleCheck size={13} aria-label="Working" />
      <span className="text-fg-secondary">
        {[
          status.version,
          status.latencyMs != null ? `${Math.round(status.latencyMs)} ms` : null,
          status.modelCount != null ? `${status.modelCount} models` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'ok'}
      </span>
    </span>
  );
}

function Providers({ title, providers }: { title: string; providers: Provider[] }) {
  return (
    <Card title={title} padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-footnote">
          <thead className="text-left text-caption text-fg-muted">
            <tr>
              <th className="px-4 py-2 font-normal">Type</th>
              <th className="px-3 py-2 font-normal">Host</th>
              <th className="px-3 py-2 font-normal">Enabled</th>
              <th className="px-3 py-2 font-normal">Key</th>
              <th className="px-3 py-2 font-normal">Models</th>
              <th className="px-4 py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p, i) => (
              <tr key={i} className="border-t border-line-subtle align-top">
                <td className="px-4 py-2 font-medium whitespace-nowrap">{p.type}</td>
                <td className="px-3 py-2 font-mono text-caption whitespace-nowrap text-fg-secondary">{p.host}</td>
                <td className="px-3 py-2">{p.enabled ? 'Yes' : <span className="text-fg-muted">No</span>}</td>
                <td className="px-3 py-2">{p.keySet ? 'Set' : <span className="text-fg-muted">–</span>}</td>
                <td className="px-3 py-2">
                  {p.models?.length ? (
                    <details>
                      <summary className="cursor-default tabular">{p.models.length}</summary>
                      <ul className="mt-1 max-h-48 overflow-auto font-mono text-caption text-fg-secondary">
                        {p.models.map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <span className="text-fg-muted">–</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <Status status={p.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function InferenceCard({ inf }: { inf: Inference }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {inf.kind}
          <span className="font-mono text-caption font-normal text-fg-muted">{inf.host}</span>
        </span>
      }
      actions={inf.version && <Badge>{inf.version}</Badge>}
    >
      <div className="space-y-4">
        {inf.error && <div className="text-footnote text-danger-text">{inf.error}</div>}
        <div className="space-y-1.5">
          <h3 className="text-caption font-medium tracking-wide text-fg-muted uppercase">Loaded now</h3>
          {inf.loaded?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-footnote tabular">
                <thead className="text-left text-caption text-fg-muted">
                  <tr>
                    <th className="py-1 pr-3 font-normal">Model</th>
                    <th className="py-1 pr-3 text-right font-normal">VRAM</th>
                    <th className="py-1 pr-3 text-right font-normal">Size</th>
                    <th className="py-1 pr-3 font-normal">Quant.</th>
                    <th className="py-1 pr-3 text-right font-normal">Context</th>
                    <th className="py-1 font-normal">Until</th>
                  </tr>
                </thead>
                <tbody>
                  {inf.loaded.map((m) => (
                    <tr key={m.name} className="border-t border-line-subtle">
                      <td className="py-1 pr-3 font-mono text-caption">{m.name}</td>
                      <td className="py-1 pr-3 text-right">{m.vramBytes != null ? bytes(m.vramBytes) : '–'}</td>
                      <td className="py-1 pr-3 text-right">{m.sizeBytes != null ? bytes(m.sizeBytes) : '–'}</td>
                      <td className="py-1 pr-3">{[m.quantization, m.parameters].filter(Boolean).join(', ') || '–'}</td>
                      <td className="py-1 pr-3 text-right">{m.contextLength ? num(m.contextLength) : '–'}</td>
                      <td className="py-1 text-fg-secondary">
                        {m.expiresAt
                          ? new Date(m.expiresAt).toLocaleString('en', {
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false,
                            })
                          : '–'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-footnote text-fg-muted">Nothing loaded.</div>
          )}
        </div>
        {inf.devices && inf.devices.length > 0 && (
          <div className="space-y-1.5">
            <h3 className="text-caption font-medium tracking-wide text-fg-muted uppercase">Devices</h3>
            <ul className="space-y-1 text-footnote">
              {inf.devices.map((dev, i) => (
                <li key={i}>
                  {dev.name}
                  {dev.type && <span className="text-fg-muted"> ({dev.type})</span>}
                  <span className="text-fg-secondary tabular">
                    {dev.vramBytes ? ` · ${bytes(dev.vramBytes)} VRAM` : ''}
                    {dev.vramFreeBytes != null ? `, ${bytes(dev.vramFreeBytes)} free` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {inf.models && inf.models.length > 0 && (
          <details>
            <summary className="cursor-default text-footnote text-fg-secondary">
              {inf.models.length} installed models
            </summary>
            <ul className="mt-2 grid gap-x-6 gap-y-0.5 text-caption sm:grid-cols-2">
              {inf.models.map((m) => (
                <li key={m.name} className="flex justify-between gap-3">
                  <span className="truncate font-mono">{m.name}</span>
                  <span className="shrink-0 text-fg-muted tabular">{m.sizeBytes ? bytes(m.sizeBytes) : ''}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {(inf.slots != null || inf.notes) && (
          <Facts
            rows={[
              ['Slots', inf.slots != null ? num(inf.slots) : null],
              ...Object.entries(inf.notes ?? {}).map(([k, v]): [string, ReactNode] => [k, v]),
            ]}
          />
        )}
      </div>
    </Card>
  );
}

export function SystemTab({ report }: { report: ReportEnvelope }) {
  const d = report.diagnostics;
  if (!d) return <div className="text-footnote text-fg-muted">This report came without diagnostics.</div>;
  const app = report.app;
  const same = app.mode === 'desktop-local' && d.client && d.backend;
  return (
    <div className="space-y-4">
      <Card title="Atelier">
        <Facts
          columns={2}
          rows={[
            ['Version', app.version],
            ['Channel', app.channel],
            ['Packaged', yes(app.packaged)],
            ['Mode', app.mode],
            ['Surface', app.surface],
            ['Server version', app.serverVersion],
            ['Window', app.window ? `${app.window.width} × ${app.window.height} at ${app.window.ratio}×` : null],
            ['Theme', app.theme],
            ['Language', app.language],
            ['Collected', dateTime(d.collectedAt)],
          ]}
        />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {same ? (
          <div className="lg:col-span-2">
            <Computer title="This computer" system={merge(d.client!, d.backend!)} backend={d.backend} />
          </div>
        ) : (
          <>
            {d.client && (
              <Computer
                title={app.mode === 'desktop-server' ? 'This computer (the app)' : 'The person’s computer'}
                system={d.client}
              />
            )}
            {d.backend && <Computer title="Backend" system={d.backend} backend={d.backend} />}
          </>
        )}
      </div>
      {d.providers && d.providers.length > 0 && <Providers title="Providers" providers={d.providers} />}
      {d.imageProviders && d.imageProviders.length > 0 && (
        <Providers title="Image providers" providers={d.imageProviders} />
      )}
      {d.inference && d.inference.length > 0 && (
        <div className="space-y-4">
          {d.inference.map((inf, i) => (
            <InferenceCard key={i} inf={inf} />
          ))}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {d.connectors && d.connectors.length > 0 && (
          <Card title="Connectors" padded={false}>
            <table className="w-full text-footnote">
              <tbody>
                {d.connectors.map((c, i) => (
                  <tr key={i} className="border-t border-line-subtle first:border-t-0 align-top">
                    <td className="px-4 py-1.5 font-medium">{c.type}</td>
                    <td
                      className={
                        c.status === 'connected' || c.status === 'ok'
                          ? 'px-3 py-1.5 text-success-text'
                          : 'px-3 py-1.5 text-fg-secondary'
                      }
                    >
                      {c.status}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-fg-muted tabular">
                      {c.tools != null ? `${c.tools} tools` : ''}
                    </td>
                    <td className="px-4 py-1.5 break-words text-danger-text">{c.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {d.computerUse && (
          <Card title="Computer use">
            <Facts
              rows={[
                ['Available', yes(d.computerUse.available)],
                ['Enabled', yes(d.computerUse.enabled)],
                ['Helper', d.computerUse.helper],
                ...Object.entries(d.computerUse.notes ?? {}).map(([k, v]): [string, ReactNode] => [k, v]),
              ]}
            />
          </Card>
        )}
        {d.notes && Object.keys(d.notes).length > 0 && (
          <Card title="Notes">
            <Facts rows={Object.entries(d.notes).map(([k, v]): [string, ReactNode] => [k, v])} />
          </Card>
        )}
      </div>
    </div>
  );
}
