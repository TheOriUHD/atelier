/**
 * "Report an issue" and "Request a feature" (ARCHITECTURE §26): one dialog, two kinds, each landing in its own inbox on
 * the Atelier developer's side. The person writes what happened (or what they'd like); diagnostics, a conversation and
 * pictures can go with it, each shown before it is sent. An issue attaches diagnostics by default, a feature request
 * doesn't. Nothing is sent until Send is pressed, and what is sent never holds keys or passwords.
 */
import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Activity, Bug, Check, Copy, ImagePlus, Lightbulb, MessagesSquare, X } from 'lucide-react';
import { REPORT_LIMITS, reportTextProblem, type ReportChat, type ReportKind } from '@atelier/protocol';
import { Button, Dialog, DialogContent, DialogFooter, Field, Icon, IconButton, SegmentedControl, Switch, TextArea, TextField, cn } from '../../components/ui/index.ts';
import { relativeTime } from '../../lib/dates.ts';
import { openExternal } from '../../lib/platform.ts';
import { useAppInfo, useSessions } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { sessionTitle } from '../../lib/sessions.ts';
import { clientHalf } from './report-client.ts';
import { compressPicture, PictureError } from './report-images.ts';
import { MAX_SHOTS, useReports } from './report-store.ts';

const DOCS = 'https://docs.atelierhq.dev/reporting-issues/';

const COPY: Record<ReportKind, { title: string; heading: string; titlePlaceholder: string; body: string; bodyPlaceholder: string; sent: string }> = {
  issue: {
    title: 'Report an issue',
    heading: 'What went wrong?',
    titlePlaceholder: 'In a few words: “Chat stops after attaching a PDF”',
    body: 'What happened?',
    bodyPlaceholder: 'What did you do, what happened, and what did you expect instead?',
    sent: 'Your report is in.',
  },
  feature: {
    title: 'Request a feature',
    heading: 'What would you like?',
    titlePlaceholder: 'In a few words: “Search inside attached PDFs”',
    body: 'Describe it',
    bodyPlaceholder: 'What would it let you do, and how would you use it?',
    sent: 'Your request is in.',
  },
};

/** "All 42 messages", or how much of a long one goes. */
export function coverageText(chat: Pick<ReportChat, 'coverage'>): string {
  const { total, included, shortened } = chat.coverage;
  if (total === 0) return 'It has no messages yet.';
  const what = included >= total ? `All ${total} message${total === 1 ? '' : 's'}` : `${included} of its ${total} messages: how it started and the newest ones`;
  return shortened ? `${what}, some shortened to fit.` : `${what}.`;
}

const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e6 ? 2 : 1)} MB`;

export function ReportDialog() {
  const { open, kind, drafts, shots, close, setKind, setDraft, addShots, removeShot, sent } = useReports();
  const info = useAppInfo().data;
  const params = useParams({ strict: false }) as { sessionId?: string };
  const draft = drafts[kind];
  const copy = COPY[kind];

  // An issue always carries diagnostics: without them it can rarely be followed up. A feature request only on request.
  const [featureDiagnostics, setFeatureDiagnostics] = useState(false);
  const withDiagnostics = kind === 'issue' || featureDiagnostics;
  const [withChat, setWithChat] = useState(false);
  // The conversation it was opened from is the one offered first. (A new dialog is mounted for each opening.)
  const [chatId, setChatId] = useState<string | null>(() => params.sessionId ?? null);
  const [preview, setPreview] = useState<'diagnostics' | 'chat' | null>(null);
  const [tried, setTried] = useState(false);
  const [pictureError, setPictureError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; kind: ReportKind } | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [chatQuery, setChatQuery] = useState('');

  const sessions = useSessions({}, { enabled: open });
  /** The person's conversations, the one open now first, newest next. */
  const chats = useMemo(() => {
    const list = (sessions.data ?? []).filter((s) => !s.temporary);
    const here = list.find((s) => s.id === params.sessionId);
    return [...(here ? [here] : []), ...list.filter((s) => s.id !== params.sessionId)];
  }, [sessions.data, params.sessionId]);
  const chosenChat = withChat ? (chatId && chats.some((s) => s.id === chatId) ? chatId : (chats[0]?.id ?? null)) : null;
  const shownChats = useMemo(() => {
    const q = chatQuery.trim().toLowerCase();
    return (q ? chats.filter((s) => sessionTitle(s).toLowerCase().includes(q)) : chats).slice(0, 100);
  }, [chats, chatQuery]);

  const client = useQuery({ queryKey: ['reports', 'client'], queryFn: clientHalf, enabled: open, staleTime: 30_000, gcTime: 60_000 });
  const prepared = useQuery({
    queryKey: ['reports', 'prepare', withDiagnostics, chosenChat],
    queryFn: () => rpc().call('reports.prepare', { kind, diagnostics: withDiagnostics, chatSessionId: chosenChat }),
    enabled: open && info?.reports === true && (withDiagnostics || chosenChat !== null),
    staleTime: 30_000,
    gcTime: 60_000,
  });

  const diagnostics = withDiagnostics && prepared.data?.diagnostics ? { ...prepared.data.diagnostics, ...(client.data?.diagnostics ?? {}) } : null;
  const chat = chosenChat ? (prepared.data?.chat ?? null) : null;

  const titleProblem = reportTextProblem('title', draft.title);
  const bodyProblem = reportTextProblem('description', draft.description);

  const send = useMutation({
    mutationFn: async () => {
      const half = client.data ?? (await clientHalf());
      const ready = withDiagnostics || chosenChat ? (prepared.data ?? (await prepared.refetch()).data) : null;
      if ((withDiagnostics || chosenChat) && !ready) throw new Error('The diagnostics could not be collected. Turn them off and send again.');
      return rpc().call('reports.submit', {
        kind,
        title: draft.title.trim(),
        description: draft.description.trim(),
        ...(draft.contact.trim() ? { contact: draft.contact.trim() } : {}),
        app: half.app,
        diagnostics: withDiagnostics && ready?.diagnostics ? { ...ready.diagnostics, ...half.diagnostics } : null,
        chat: chosenChat ? (ready?.chat ?? null) : null,
        screenshots: shots.map((s) => ({ mime: s.mime, dataBase64: s.dataBase64, width: s.width, height: s.height })),
      });
    },
    onSuccess: (r) => {
      setReceipt({ id: r.id, kind });
      sent(kind);
      setFeatureDiagnostics(false);
      setWithChat(false);
    },
  });

  const addPictures = async (files: readonly File[]) => {
    setPictureError(null);
    const pictures = files.filter((f) => f.type.startsWith('image/'));
    if (!pictures.length) return;
    if (shots.length + pictures.length > MAX_SHOTS) setPictureError(`At most ${MAX_SHOTS} pictures.`);
    const done = await Promise.allSettled(pictures.slice(0, Math.max(0, MAX_SHOTS - shots.length)).map((f) => compressPicture(f, 'added')));
    addShots(done.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
    const failed = done.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) setPictureError(failed.reason instanceof PictureError ? failed.reason.message : 'That picture could not be added.');
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      void addPictures(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    void addPictures([...e.dataTransfer.files]);
  };

  // An older server has no `reports.*`; one whose admin turned reports off says so.
  const unsupported = info !== undefined && info.reports === undefined;
  const disabled = info?.reports === false || unsupported;
  const submit = () => {
    setTried(true);
    if (titleProblem || bodyProblem || send.isPending || disabled) return;
    send.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {/* Below the window's title bar on every side: a long report scrolls inside the dialog. */}
      <DialogContent title={receipt ? 'Thank you' : copy.title} width={620} className="max-h-[calc(100dvh-96px)]" onPaste={onPaste} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        {receipt ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 text-body text-fg">
              <span className="grid size-8 place-items-center rounded-full bg-success-subtle text-success-text">
                <Icon icon={Check} size="md" />
              </span>
              <span>{COPY[receipt.kind].sent} It goes straight to the Atelier developer.</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-fill-secondary px-3 py-2 text-body">
              <span className="text-fg-secondary">{receipt.kind === 'issue' ? 'Report' : 'Request'}</span>
              <span className="font-mono text-fg" data-testid="report-id">
                {receipt.id}
              </span>
              <span className="ml-auto" />
              <Button
                size="sm"
                leadingIcon={copied ? Check : Copy}
                onClick={() => {
                  void navigator.clipboard?.writeText(receipt.id).then(() => setCopied(true));
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-footnote text-fg-muted">Mention it if you write about this anywhere else, so the two can be matched.</p>
            <DialogFooter>
              <Button variant="primary" onClick={close} autoFocus>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex flex-col gap-5"
          >
            <SegmentedControl
              className="self-start"
              aria-label="Kind"
              items={[
                { value: 'issue', label: 'Issue', icon: Bug },
                { value: 'feature', label: 'Feature request', icon: Lightbulb },
              ]}
              value={kind}
              onValueChange={(v) => {
                setKind(v as ReportKind);
                setTried(false);
              }}
            />
            {disabled && (
              <p className="rounded-lg bg-warning-subtle px-3 py-2 text-body text-warning-text">
                {unsupported ? 'This server is too old to send reports. Ask its admin to update it.' : 'An admin turned off reports on this server.'}
              </p>
            )}
            <Field label="Title" error={tried ? titleProblem : null}>
              <TextField autoFocus value={draft.title} maxLength={REPORT_LIMITS.titleMax} placeholder={copy.titlePlaceholder} onChange={(e) => setDraft(kind, { title: e.target.value })} />
            </Field>
            <Field label={copy.body} error={tried ? bodyProblem : null} description={!tried || !bodyProblem ? 'A sentence or two is plenty.' : undefined}>
              <TextArea rows={5} value={draft.description} maxLength={REPORT_LIMITS.descriptionMax} placeholder={copy.bodyPlaceholder} onChange={(e) => setDraft(kind, { description: e.target.value })} />
            </Field>

            <section aria-label="Attach" className="flex flex-col divide-y divide-line-subtle rounded-xl ring-1 ring-line">
              <AttachRow
                icon={Activity}
                title="Diagnostics"
                description={
                  kind === 'issue'
                    ? "Always sent with an issue: Atelier's version, this computer's hardware, settings, providers and local model servers. Never keys, passwords or personal details."
                    : "Atelier's version, this computer's hardware, settings, providers and local model servers. Never keys, passwords or personal details."
                }
                checked={withDiagnostics}
                onCheckedChange={kind === 'issue' ? undefined : setFeatureDiagnostics}
                previewOpen={preview === 'diagnostics'}
                onPreview={() => setPreview(preview === 'diagnostics' ? null : 'diagnostics')}
                loading={withDiagnostics && (prepared.isFetching || client.isFetching)}
              >
                {preview === 'diagnostics' && <Preview value={diagnostics} loading={prepared.isFetching || client.isFetching} error={prepared.error} />}
              </AttachRow>
              <AttachRow
                icon={MessagesSquare}
                title="A conversation"
                description={withChat && chat ? coverageText(chat) : 'One chat or Code session, with its tool calls, so the problem can be followed step by step. Keys and passwords in it are taken out.'}
                checked={withChat}
                onCheckedChange={(on) => {
                  setWithChat(on);
                  if (!on && preview === 'chat') setPreview(null);
                }}
                previewOpen={preview === 'chat'}
                onPreview={withChat ? () => setPreview(preview === 'chat' ? null : 'chat') : undefined}
                loading={withChat && prepared.isFetching}
              >
                {withChat && (
                  <div className="mt-3 flex flex-col gap-2">
                    {chats.length > 6 && <TextField value={chatQuery} placeholder="Find a conversation" aria-label="Find a conversation" onChange={(e) => setChatQuery(e.target.value)} />}
                    {chats.length ? (
                      <div role="radiogroup" aria-label="Conversation" className="flex max-h-44 flex-col overflow-y-auto rounded-lg p-1 ring-1 ring-line-subtle">
                        {shownChats.map((s) => {
                          const on = s.id === chosenChat;
                          return (
                            <button
                              key={s.id}
                              type="button"
                              role="radio"
                              aria-checked={on}
                              onClick={() => setChatId(s.id)}
                              className={cn('flex min-h-8 shrink-0 items-center gap-2 rounded-md px-2 text-left text-body outline-none focus-ring hover:bg-fill-ghost-hover', on && 'bg-fill-ghost-selected')}
                            >
                              <span className="min-w-0 flex-1 truncate text-fg">{sessionTitle(s)}</span>
                              {s.id === params.sessionId && <span className="shrink-0 text-footnote text-fg-muted">open now</span>}
                              <span className="shrink-0 text-footnote text-fg-muted">{relativeTime(s.updatedAt)}</span>
                              {on && <Icon icon={Check} size="sm" className="shrink-0 text-fg-secondary" />}
                            </button>
                          );
                        })}
                        {!shownChats.length && <p className="px-2 py-1.5 text-footnote text-fg-muted">No conversation by that name.</p>}
                      </div>
                    ) : (
                      <p className="text-footnote text-fg-muted">{sessions.isLoading ? 'Loading your conversations…' : 'You have no conversations yet.'}</p>
                    )}
                  </div>
                )}
                {preview === 'chat' && <Preview value={chat} loading={prepared.isFetching} error={prepared.error} />}
              </AttachRow>
              <div className="flex flex-col gap-3 px-4 py-3">
                <div className="flex items-start gap-3">
                  <Icon icon={ImagePlus} size="md" className="mt-0.5 text-fg-secondary" />
                  <div className="min-w-0 flex-1">
                    <div className="text-body font-medium text-fg">Pictures</div>
                    <div className="text-footnote text-fg-muted">Up to {MAX_SHOTS}. Paste, drop or add them; they are made smaller before sending.</div>
                  </div>
                  <Button size="sm" disabled={shots.length >= MAX_SHOTS} onClick={() => fileInput.current?.click()}>
                    Add
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    aria-label="Add pictures"
                    onChange={(e) => {
                      void addPictures([...(e.target.files ?? [])]);
                      e.target.value = '';
                    }}
                  />
                </div>
                {shots.length > 0 && (
                  <ul className="grid grid-cols-4 gap-2" aria-label="Attached pictures">
                    {shots.map((s) => (
                      <li key={s.id} className="group relative overflow-hidden rounded-lg ring-1 ring-line">
                        <img src={s.url} alt={s.source === 'window' ? 'Screenshot of Atelier' : 'Attached picture'} className="aspect-video w-full bg-fill-secondary object-cover" />
                        <span className="absolute bottom-1 left-1 rounded bg-popover px-1 text-[11px] text-fg-secondary">{s.source === 'window' ? 'Atelier' : megabytes(s.bytes)}</span>
                        <IconButton icon={X} label="Take out" iconSize="sm" floating className="absolute top-1 right-1" onClick={() => removeShot(s.id)} />
                      </li>
                    ))}
                  </ul>
                )}
                {pictureError && <p className="text-footnote text-danger-text">{pictureError}</p>}
              </div>
            </section>

            <Field label="Contact (optional)" description="An email address or GitHub name, if you'd like an answer. Only the Atelier developer sees it.">
              <TextField value={draft.contact} maxLength={REPORT_LIMITS.contactMax} placeholder="you@example.com" onChange={(e) => setDraft(kind, { contact: e.target.value })} />
            </Field>

            {send.error && (
              <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-body text-danger-text">
                {send.error instanceof Error ? send.error.message : String(send.error)}
              </p>
            )}

            <DialogFooter className="mt-1 justify-between">
              <button type="button" className="text-footnote text-fg-muted underline-offset-2 hover:underline" onClick={() => openExternal(DOCS)}>
                What is sent, and where it goes
              </button>
              <div className="flex gap-3">
                <Button onClick={close}>Cancel</Button>
                <Button type="submit" variant="primary" loading={send.isPending} disabled={disabled}>
                  {send.isPending ? 'Sending…' : 'Send'}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AttachRow(props: {
  icon: typeof Activity;
  title: string;
  description: string;
  checked: boolean;
  /** Absent: always attached, so there is nothing to switch. */
  onCheckedChange?: ((on: boolean) => void) | undefined;
  previewOpen: boolean;
  onPreview?: (() => void) | undefined;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Icon icon={props.icon} size="md" className="mt-0.5 text-fg-secondary" />
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-fg">{props.title}</div>
          <div className="text-footnote text-fg-muted">{props.description}</div>
        </div>
        {props.checked && props.onPreview && (
          <Button size="sm" variant="ghost" onClick={props.onPreview} aria-expanded={props.previewOpen}>
            {props.previewOpen ? 'Hide' : 'Show'}
          </Button>
        )}
        {props.onCheckedChange ? (
          <Switch aria-label={props.title} checked={props.checked} onCheckedChange={props.onCheckedChange} />
        ) : (
          <span className="mt-0.5 shrink-0 text-footnote text-fg-muted">Always</span>
        )}
      </div>
      {props.children}
    </div>
  );
}

/** Exactly what goes, as the collector gets it. */
function Preview({ value, loading, error }: { value: unknown; loading: boolean; error: unknown }) {
  const text = useMemo(() => (value ? JSON.stringify(value, null, 2) : ''), [value]);
  return (
    <div className={cn('mt-3 max-h-72 overflow-auto rounded-lg bg-code-background p-3 font-mono text-[12px]/[18px] text-fg', loading && 'opacity-60')}>
      {error ? (
        <span className="text-danger-text">{error instanceof Error ? error.message : String(error)}</span>
      ) : text ? (
        <pre className="break-words whitespace-pre-wrap">{text.length > 200_000 ? `${text.slice(0, 200_000)}\n… (${megabytes(text.length)} in all)` : text}</pre>
      ) : (
        <span className="text-fg-muted">{loading ? 'Collecting…' : 'Nothing yet.'}</span>
      )}
    </div>
  );
}

/** A fresh dialog for each opening (its choices start over; the draft lives in the store), kept mounted while it closes. */
export function ReportHost() {
  const opens = useReports((s) => s.opens);
  return opens ? <ReportDialog key={opens} /> : null;
}
