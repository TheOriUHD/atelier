/**
 * Settings › Admin › Developer (admins): the request inspector for model providers, each connector's log, and a reload
 * for connectors and the skill, command, agent and plugin lists.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { InspectedRequest } from '@atelier/protocol';
import { Badge, Button, Dialog, DialogContent, Select, Switch, toast, type BadgeTone } from '../../components/ui/index.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useSetting } from './use-setting.ts';

const REQUESTS = ['developer', 'requests'] as const;
const KEEP = 100;

export function DeveloperPage() {
  return (
    <>
      <InspectorSection />
      <ConnectorLogs />
      <SettingsSection title="Reload">
        <SettingRow id="developer.reload">
          <Button
            onClick={() =>
              void rpc()
                .call('developer.reload', {})
                .then(
                  () => toast.success('Reconnecting connectors and reading extensions again.'),
                  (e: unknown) => toast.error(describeError(e).message),
                )
            }
          >
            Reload
          </Button>
        </SettingRow>
      </SettingsSection>
    </>
  );
}

function InspectorSection() {
  const qc = useQueryClient();
  const inspector = useSetting<boolean>(['developer', 'inspector']);
  const requests = useQuery({ queryKey: REQUESTS, queryFn: () => rpc().call('developer.requests', {}) });
  const [shown, setShown] = useState<InspectedRequest | null>(null);
  useEffect(() => rpc().on('developer.request', (request) => qc.setQueryData<InspectedRequest[]>(REQUESTS, (list) => [request, ...(list ?? [])].slice(0, KEEP))), [qc]);
  const list = requests.data ?? [];
  const clear = () => void rpc().call('developer.clearRequests', {}).then(() => qc.setQueryData(REQUESTS, []));

  return (
    <SettingsSection title="Request inspector" action={list.length > 0 && <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>}>
      <SettingRow id="developer.inspector" setting={inspector}>
        {(label) => <Switch {...label} checked={inspector.value} onCheckedChange={(v) => void inspector.set(v)} />}
      </SettingRow>
      {list.length > 0 ? (
        <DataTable
          label="Provider requests"
          columns={[{ label: 'Time', className: 'w-28' }, { label: 'Request' }, { label: 'Status', className: 'w-24' }, { label: 'Answered after', className: 'w-28 text-right' }]}
        >
          {list.map((r) => (
            <TableRow key={r.id}>
              <Cell className="text-footnote whitespace-nowrap tabular-nums">{new Date(r.at).toLocaleTimeString()}</Cell>
              <Cell>
                <button type="button" className="block w-full truncate text-left font-mono text-code text-fg hover:underline focus-ring" onClick={() => setShown(r)}>
                  {r.method} {shortUrl(r.url)}
                </button>
              </Cell>
              <Cell>
                <Badge tone={tone(r)}>{r.error ? 'Failed' : (r.status ?? '…')}</Badge>
              </Cell>
              <Cell className="text-right tabular-nums">{r.ms === null ? '' : `${r.ms} ms`}</Cell>
            </TableRow>
          ))}
        </DataTable>
      ) : (
        <p className="py-3 text-body text-fg-muted">{inspector.value ? 'No requests yet. Send a message to see the requests it makes.' : 'Switch the inspector on to record requests.'}</p>
      )}
      <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)}>
        {shown && (
          <DialogContent title={`${shown.method} ${shortUrl(shown.url)}`} description={new Date(shown.at).toLocaleString()} width={640}>
            <RequestDetail request={shown} />
          </DialogContent>
        )}
      </Dialog>
    </SettingsSection>
  );
}

function RequestDetail({ request }: { request: InspectedRequest }) {
  const facts: [string, string][] = [
    ['Address', request.url],
    ['Status', request.error ?? String(request.status ?? 'No answer')],
    ...(request.ms !== null ? ([['Answered after', `${request.ms} ms`]] as [string, string][]) : []),
    ...(request.requestBytes !== null ? ([['Request size', `${request.requestBytes.toLocaleString()} bytes`]] as [string, string][]) : []),
  ];
  return (
    <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-body">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="min-w-0 break-all text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      <section>
        <h3 className="mb-1 text-footnote text-fg-muted">Request headers</h3>
        <pre className="overflow-x-auto rounded-lg bg-code-bg p-3 font-mono text-code text-fg">
          {Object.entries(request.requestHeaders)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n') || '(none)'}
        </pre>
      </section>
      {request.errorBody && (
        <section>
          <h3 className="mb-1 text-footnote text-fg-muted">Response</h3>
          <pre className="overflow-x-auto rounded-lg bg-code-bg p-3 font-mono text-code whitespace-pre-wrap text-fg">{request.errorBody}</pre>
        </section>
      )}
    </div>
  );
}

function ConnectorLogs() {
  const servers = useQuery({ queryKey: ['developer', 'connectors'], queryFn: () => rpc().call('mcp.status', {}) });
  const names = (servers.data ?? []).map((s) => s.name);
  const [picked, setPicked] = useState<string | null>(null);
  const name = picked && names.includes(picked) ? picked : (names[0] ?? null);
  const logs = useQuery({
    queryKey: ['developer', 'logs', name],
    queryFn: () => rpc().call('mcp.logs', { name: name! }),
    enabled: name !== null,
    refetchInterval: 2000,
  });
  return (
    <SettingsSection id="developer.connectorLogs" title="Connector logs" description="What each connector printed, and its connections and failures. Credentials are masked.">
      {name === null ? (
        <p className="text-body text-fg-muted">No connectors yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <Select aria-label="Connector" variant="field" className="w-60" options={names.map((n) => ({ value: n, label: n }))} value={name} onValueChange={setPicked} />
          <pre aria-label={`Log of ${name}`} className="h-72 overflow-auto rounded-lg bg-code-bg p-3 font-mono text-code whitespace-pre-wrap text-fg">
            {logs.data?.lines.join('\n') || 'Nothing logged yet.'}
          </pre>
        </div>
      )}
    </SettingsSection>
  );
}

function tone(r: InspectedRequest): BadgeTone {
  if (r.error) return 'danger';
  if (r.status === null) return 'neutral';
  return r.status < 300 ? 'success' : r.status < 500 ? 'warning' : 'danger';
}

/** Host and path, for the list; the full address is in the details. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}
