import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { ArrowUp, CornerDownLeft, FileText, Paperclip, Square, Telescope, TriangleAlert, X } from 'lucide-react';
import type { McpServerStatus, ModelInfo } from '@atelier/protocol';
import { Badge, Button, Dialog, DialogContent, Icon, Lightbox, Spinner, Tooltip, cn } from '../../components/ui/index.ts';
import { blobUrl, saveBlob } from '../../lib/platform.ts';
import { pressIs, useShortcut } from '../../lib/shortcuts.ts';
import { useComposerMenu, type SlashCommand } from './composer-menu.tsx';
import { leadingCommand } from './command-text.tsx';
import { PlusMenu } from './plus-menu.tsx';
import type { ResearchSwitch } from './research.ts';
import { QuoteTile } from './quote.tsx';
import { isImage, isText, type Attachment, type Attachments } from './use-attachments.ts';
import { useIsActiveCell } from '../../lib/split-cell.tsx';
import { useDraft } from '../../lib/drafts.ts';

export interface ComposerHandle {
  /** Replaces the draft (e.g. with a message rewound to) and focuses the box. */
  setText(text: string): void;
  /** Adds text to the draft on a line of its own (a waiting message taken back), and focuses the box. */
  append(text: string): void;
  /** Adds an `@path` file mention (a workspace file or folder, Files › Attach as context) after the draft, and focuses the box. */
  mention(path: string): void;
  focus(): void;
}

export interface ComposerProps {
  ref?: Ref<ComposerHandle>;
  variant: 'new' | 'reply';
  /** Names the draft kept when the person leaves and comes back (lib/drafts.ts `draftKeys`); none keeps nothing. */
  draftKey?: string;
  attachments: Attachments;
  model: ModelInfo | undefined;
  streaming: boolean;
  onSubmit(text: string): void;
  onStop?(): void;
  /** Built-in `/` commands; skills and custom commands come from the backend. */
  commands?: SlashCommand[];
  /** The Code workspace: scopes skills and commands, and offers `@` file mentions. */
  workspaceId?: string | null;
  /** Row under the box: left (project), centered (notice) and right (context meter, model). */
  footerStart?: ReactNode;
  footerCenter?: ReactNode;
  footerEnd?: ReactNode;
  autoFocus?: boolean;
  /** The 40px one-line box of the Code and Cowork homes and Code sessions (a 48px row otherwise). */
  compact?: boolean;
  /** Overrides the default prompt ("How can I help you today?" / "Reply"). */
  placeholder?: string;
  /** Sees keys first; `preventDefault()` keeps the composer from handling them (Code: Shift+Tab cycles the mode). */
  onKeyDown?(e: KeyboardEvent<HTMLTextAreaElement>): void;
  /** The connectors this session may use, and the ones switched off for it (the + menu lists them). */
  connectors?: ConnectorSwitches;
  /** Research on or off (the + menu's toggle); absent while web search is off. */
  research?: ResearchSwitch;
  /** A new conversation: + › Add folder turns it into a Cowork task in the folder picked. */
  onAddFolder?(workspaceId: string): void;
  /**
   * What the run waits on (a permission prompt, a question, a plan, a folder change): docked to the top of the box, so
   * it is where the person is typing and the transcript stays what was said.
   */
  dock?: ReactNode;
  /** A temporary chat: the box gets a dashed border, so the state is clear where the person types. */
  temporary?: boolean;
  /**
   * A short guess at the person's next message (Code and Cowork): shown in place of the prompt while the box is empty,
   * Tab puts it in. Typing anything, or putting it in, sets it aside until the next one.
   */
  suggestion?: string | null;
}

export interface ConnectorSwitches {
  list: readonly McpServerStatus[];
  off: readonly string[];
  onChange(off: string[]): void;
}

/**
 * The message box. New chats get the tall 640px variant with the attach button inside;
 * conversations get a one-row 768px reply box that grows with its content (max 384px).
 */
export function Composer({
  ref,
  variant,
  draftKey,
  attachments,
  model,
  streaming,
  onSubmit,
  onStop,
  commands = [],
  workspaceId,
  footerStart,
  footerCenter,
  footerEnd,
  autoFocus,
  compact,
  placeholder,
  onKeyDown,
  connectors,
  research,
  onAddFolder,
  dock,
  temporary,
  suggestion,
}: ComposerProps) {
  const [text, setText] = useDraft(draftKey);
  const [setAside, setSetAside] = useState<string | null>(null);
  const suggested = suggestion && suggestion !== setAside && text === '' && !streaming ? suggestion : null;
  const [caret, setCaret] = useState(0);
  // Where the caret goes once the text a menu pick (or a rewind) put in has rendered.
  const placeCaret = useRef<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const replace = (next: string, at: number) => {
    setText(next);
    setCaret(at);
    placeCaret.current = at;
    input.current?.focus();
  };
  useImperativeHandle(ref, () => ({
    setText: (next) => replace(next, next.length),
    append: (more) => replace(text.trim() ? `${text.replace(/\s+$/, '')}\n${more}` : more, Number.MAX_SAFE_INTEGER),
    mention: (path) => replace(`${text.trim() ? `${text.replace(/\s+$/, '')} ` : ''}@${path} `, Number.MAX_SAFE_INTEGER),
    focus: () => input.current?.focus(),
  }));
  const menu = useComposerMenu({ text, caret, commands, workspaceId, onChange: replace });

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 384)}px`;
    if (placeCaret.current !== null) {
      el.setSelectionRange(placeCaret.current, placeCaret.current);
      placeCaret.current = null;
    }
  }, [text]);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus, draftKey]);

  // ⌘U / Ctrl+U (or the person's own): upload or add files, wherever the focus is on the page (in a split view: in the
  // cell you are working in).
  const activeCell = useIsActiveCell();
  const upload = useShortcut('upload');
  useEffect(() => {
    if (!activeCell || !upload) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!pressIs(upload, e)) return;
      e.preventDefault();
      fileInput.current?.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeCell, upload]);

  const lead = leadingCommand(text);
  const mirror = useRef<HTMLDivElement>(null);
  const command = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  const builtIn = command ? commands.find((c) => c.run && c.name === command[1]) : undefined;
  const canSend = !!model && !attachments.uploading && (text.trim().length > 0 || attachments.items.some((a) => a.status === 'ready'));

  const submit = () => {
    if (builtIn) {
      setText('');
      builtIn.run!(command![2]!.trim());
      return;
    }
    // While the agent works the message is sent all the same: it waits for the agent's next step (or Send now).
    if (!canSend) return;
    onSubmit(text.trim());
    setText('');
  };

  const attachButton = (
    <>
      <PlusMenu
        onUpload={() => fileInput.current?.click()}
        onSkill={(name) => replace(`/${name} `, name.length + 2)}
        onAddFolder={onAddFolder}
        workspaceId={workspaceId}
        connectors={connectors}
        research={research}
      />
      {research?.on && (
        <Tooltip content="Research is on: each message searches broadly and cites sources">
          <button
            type="button"
            aria-pressed
            onClick={() => research.onChange(false)}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-control-sm text-interactive-text outline-none focus-ring hover:bg-fill-ghost-hover"
          >
            <Icon icon={Telescope} />
            Research
          </button>
        </Tooltip>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void attachments.add([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </>
  );

  return (
    <div className={cn('relative mx-auto w-full', variant === 'new' ? 'max-w-(--at-layout-composer-width-new-chat)' : 'max-w-(--at-layout-composer-width-chat)')}>
      {menu.menu}
      <div
        data-temporary={temporary || undefined}
        className={cn(
          'flex flex-col overflow-hidden rounded-composer bg-raised shadow-composer transition-[box-shadow,background-color] duration-(--at-duration-base) ease-standard',
          temporary && 'border-[1.5px] border-dashed border-line-stronger shadow-none',
        )}
      >
        {dock && <div className="max-h-[60vh] overflow-y-auto border-b border-line">{dock}</div>}
        <div className={cn('flex flex-col', compact ? 'p-1' : 'p-2')}>
        {(attachments.items.length > 0 || attachments.quotes.length > 0) && (
          <div className="flex gap-2 overflow-x-auto p-1.5 pb-2">
            {attachments.quotes.map((q, i) => (
              <QuoteTile key={`${i}:${q.slice(0, 24)}`} text={q} onRemove={() => attachments.removeQuote(i)} />
            ))}
            {attachments.items.map((a) => (
              <AttachmentTile key={a.key} attachment={a} model={model} onRemove={() => attachments.remove(a.key)} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-1">
          <div className="relative flex min-w-0 flex-1">
          {/* The command the message starts with is blue: a mirror of the text sits under the (then transparent) box. */}
          {lead && (
            <div
              ref={mirror}
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-0 max-h-96 overflow-hidden break-words whitespace-pre-wrap text-composer text-fg',
                variant === 'new' ? 'mt-[5px] ml-2 min-h-[42px]' : 'ml-2 min-h-8 py-[5.5px]',
              )}
            >
              <span className="text-interactive-text">{lead.command}</span>
              {lead.rest}
              {'\n'}
            </div>
          )}
          <textarea
            ref={input}
            rows={1}
            value={text}
            aria-label="Message"
            {...menu.inputProps}
            placeholder={suggested ?? placeholder ?? (variant === 'new' ? 'How can I help you today?' : 'Reply')}
            {...(suggested ? { 'aria-description': `Suggested: ${suggested}. Press Tab to use it.` } : {})}
            onChange={(e) => {
              if (suggestion && e.target.value !== '') setSetAside(suggestion);
              setText(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onScroll={(e) => {
              if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                void attachments.add(files);
              }
            }}
            onKeyDown={(e) => {
              onKeyDown?.(e);
              if (e.defaultPrevented) return;
              // Tab takes the suggestion as the person's own text, to send, change or delete.
              if (e.key === 'Tab' && !e.shiftKey && suggested && !e.nativeEvent.isComposing) {
                e.preventDefault();
                setSetAside(suggested);
                setText(suggested);
                setCaret(suggested.length);
                return;
              }
              menu.onKeyDown(e);
              if (e.defaultPrevented) return;
              // Escape interrupts the agent while the box is empty (with text it is left alone).
              if (e.key === 'Escape' && streaming && onStop && text === '' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onStop();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className={cn(
              'relative max-h-96 min-w-0 flex-1 resize-none bg-transparent text-composer text-fg outline-none placeholder:text-fg-muted',
              lead && 'text-transparent caret-fg selection:bg-interactive/30 selection:text-transparent',
              // Insets: text starts 16px in, 13px down (new) or centered in 48px (reply).
              variant === 'new' ? 'mt-[5px] ml-2 min-h-[42px]' : 'ml-2 min-h-8 py-[5.5px]',
            )}
          />
          </div>
          {variant === 'reply' && <SendOrStop streaming={streaming} canSend={canSend || !!builtIn} onSend={submit} onStop={onStop} idleHint code={compact} />}
        </div>
        {variant === 'new' && (
          <div className="mt-2 flex items-center gap-1">
            {attachButton}
            <span className="flex-1" />
            <SendOrStop streaming={streaming} canSend={canSend || !!builtIn} onSend={submit} onStop={onStop} code={compact} />
          </div>
        )}
        </div>
      </div>
      {/* Narrow screens drop the centered notice; both sides shrink, their labels truncating. */}
      <div className="grid h-8 grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 pt-2 max-md:flex max-md:justify-between">
        <div className="flex min-w-0 items-center gap-1">
          {variant === 'reply' && attachButton}
          {footerStart}
        </div>
        <div className="min-w-0 truncate text-caption text-fg-muted max-md:hidden">{footerCenter}</div>
        <div className="flex min-w-0 items-center justify-end gap-1">{footerEnd}</div>
      </div>
    </div>
  );
}

/**
 * Chat: Send (clay) once there is something to send, Stop (the same clay button with a filled square) while the agent
 * works and the box is empty. Code and Cowork (`code`) use a plainer send control: no filled button, a return glyph that is
 * muted while there is nothing to send and the text color once there is, and Stop as a ring around a small square.
 * The reply box shows the muted return glyph while empty either way.
 */
function SendOrStop({
  streaming,
  canSend,
  onSend,
  onStop,
  idleHint,
  code,
}: {
  streaming: boolean;
  canSend: boolean;
  onSend(): void;
  onStop?: () => void;
  idleHint?: boolean;
  code?: boolean | undefined;
}) {
  if (streaming && !canSend)
    return (
      <Tooltip content="Stop">
        <button
          type="button"
          aria-label="Stop"
          onClick={onStop}
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg outline-none transition-colors duration-(--at-duration-fast) focus-ring',
            code ? 'text-fg hover:bg-fill-ghost-hover' : 'bg-accent text-on-accent hover:bg-accent-hover',
          )}
        >
          {code ? (
            <span aria-hidden className="flex size-4 items-center justify-center rounded-full border-[1.5px] border-current">
              <span className="size-[6px] rounded-[1.5px] bg-current" />
            </span>
          ) : (
            <Icon icon={Square} size="sm" className="size-3 fill-current" />
          )}
        </button>
      </Tooltip>
    );
  if (!canSend && idleHint)
    return (
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center text-fg-muted">
        <Icon icon={CornerDownLeft} size="sm" />
      </span>
    );
  return (
    <button
      type="button"
      aria-label="Send"
      disabled={!canSend}
      onClick={onSend}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg outline-none transition-opacity duration-(--at-duration-fast) focus-ring',
        code ? 'text-fg hover:bg-fill-ghost-hover disabled:text-fg-muted' : 'bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-0',
      )}
    >
      <Icon icon={code ? CornerDownLeft : ArrowUp} size="sm" />
    </button>
  );
}

function AttachmentTile({ attachment: a, model, onRemove }: { attachment: Attachment; model: ModelInfo | undefined; onRemove(): void }) {
  const [open, setOpen] = useState(false);
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(a.name)?.[1] ?? a.mime.split('/')[1] ?? 'file').toUpperCase();
  const warning = isImage(a.mime) && model && !model.capabilities.vision ? `${model.displayName} can’t see images; it will be told an image was attached.` : undefined;
  return (
    <div
      className={cn(
        'group/tile relative flex size-[120px] shrink-0 flex-col overflow-hidden rounded-xl bg-bg p-3 inset-ring inset-ring-line',
        a.status === 'error' && 'inset-ring-danger',
      )}
    >
      <button type="button" aria-label={`Open ${a.name}`} disabled={!a.preview && a.status !== 'ready'} onClick={() => setOpen(true)} className="absolute inset-0 z-10 rounded-xl outline-none focus-ring disabled:cursor-default" />
      {a.preview ? (
        <img src={a.preview} alt="" className="absolute inset-0 size-full object-cover" />
      ) : (
        <>
          <span className="line-clamp-2 text-body break-all text-fg">{a.name}</span>
          <span className="mt-0.5 truncate text-caption text-fg-muted">
            {a.status === 'error' ? a.error : a.lines != null ? `${a.lines} ${a.lines === 1 ? 'line' : 'lines'}` : formatBytes(a.size)}
          </span>
          <Badge className="mt-auto self-start">
            {a.mime === 'application/pdf' ? <Icon icon={FileText} size="sm" className="mr-1 size-3" /> : null}
            {ext}
          </Badge>
        </>
      )}
      {a.status === 'uploading' && (
        <span className="absolute inset-0 flex items-center justify-center bg-bg/60">
          <Spinner />
        </span>
      )}
      {warning && (
        <Tooltip content={warning}>
          <span className="absolute bottom-2 left-2 flex size-6 items-center justify-center rounded-sm bg-warning-subtle text-warning-text">
            <Icon icon={TriangleAlert} size="sm" />
          </span>
        </Tooltip>
      )}
      <button
        type="button"
        aria-label={`Remove ${a.name}`}
        onClick={onRemove}
        className="absolute top-1.5 right-1.5 z-20 hidden size-6 items-center justify-center rounded-full bg-popover text-fg-secondary shadow-sm outline-none group-hover/tile:flex focus-visible:flex focus-ring"
      >
        <Icon icon={X} size="sm" className="size-3.5" />
      </button>
      {isImage(a.mime) && a.preview
        ? <Lightbox images={[{ src: a.preview, alt: a.name }]} index={open ? 0 : null} onIndexChange={(index) => setOpen(index !== null)} />
        : open && <AttachmentPreview attachment={a} onClose={() => setOpen(false)} />}
    </div>
  );
}

function AttachmentPreview({ attachment, onClose }: { attachment: Attachment; onClose(): void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [pdf, setPdf] = useState<string | null>(null);
  const sha = attachment.file?.blob;
  useEffect(() => {
    if (!sha || (!isText(attachment.mime) && attachment.mime !== 'application/pdf')) return;
    const controller = new AbortController();
    let url: string | undefined;
    void fetch(blobUrl(sha), { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Could not load attachment');
      if (attachment.mime === 'application/pdf') {
        const bytes = await response.arrayBuffer();
        if (!controller.signal.aborted) { url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); setPdf(url); }
      } else {
        const content = await response.text();
        if (!controller.signal.aborted) setText(content.slice(0, 200_000));
      }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [sha, attachment.mime]);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent title={attachment.name}>
      {isText(attachment.mime)
        ? <pre className="max-h-[60vh] overflow-auto rounded-lg bg-bg-sunken p-4 font-mono text-code whitespace-pre-wrap break-words">{error ? 'Could not load this attachment.' : text ?? 'Loading attachment…'}</pre>
        : attachment.mime === 'application/pdf'
          ? pdf ? <iframe title={attachment.name} src={pdf} className="h-[60vh] w-full rounded-lg border-0" /> : <p>{error ? 'Could not load this attachment.' : 'Loading attachment…'}</p>
          : <p className="text-body text-fg-secondary">{formatBytes(attachment.size)} · {attachment.mime}</p>}
      {sha && <Button onClick={() => void saveBlob(sha, attachment.name)}>Save file</Button>}
    </DialogContent>
  </Dialog>;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Drop target: shows an overlay while files are dragged over and hands them to `onFiles`. */
export function FileDropZone({ onFiles, label = 'Drop files to attach', children }: { onFiles(files: File[]): void; label?: string; children: ReactNode }) {
  const [over, setOver] = useState(0);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => hasFiles(e) && setOver((n) => n + 1)}
      onDragLeave={(e) => hasFiles(e) && setOver((n) => Math.max(0, n - 1))}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(0);
        onFiles([...e.dataTransfer.files]);
      }}
    >
      {children}
      {over > 0 && (
        <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-interactive bg-interactive-subtle text-interactive-text">
          <Icon icon={Paperclip} size="lg" />
          <span className="text-body-strong">{label}</span>
        </div>
      )}
    </div>
  );
}
