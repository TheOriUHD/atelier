/**
 * What a run waits on, at the end of the transcript and focused (design/components.md › PermissionPrompt,
 * PlanApproval): a permission prompt, plan approval, AskUser questions (Code), or a connector's request for input
 * (MCP elicitation, Chat and Code). Answers go back with chat.respond.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { APP } from '@atelier/protocol';
import { Check, ChevronDown, ExternalLink, TriangleAlert } from 'lucide-react';
import type {
  ElicitationAnswer,
  ElicitationRequest,
  PendingInteraction,
  PermissionAnswer,
  PermissionRequest,
  Question,
  QuestionAnswer,
  QuestionRequest,
} from '@atelier/protocol';
import { Badge, Button, Field, Icon, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, TextField, cn, toast } from '../../components/ui/index.ts';
import { desktop, isMac, openExternal } from '../../lib/platform.ts';
import { changeLending, isLocalAddress, useLending } from '../../lib/lending.ts';
import { useAppInfo } from '../../lib/queries.ts';
import { describeError, errorCode, rpc } from '../../lib/rpc.ts';
import { Markdown } from '../chat/markdown.tsx';
import { CommandCode } from './command-code.tsx';
import { DiffCard, editRows, writeRows } from './inline-diff.tsx';
import { displayPath, languageOf } from './paths.ts';
import { planComments, revisionMessage, usePlanComments } from './plan-comments.ts';
import { WorkspaceRoot, asRecord, str, summarize } from './tool-cards.tsx';

type Respond = (answer: PermissionAnswer | QuestionAnswer | ElicitationAnswer) => void;

/** Whether the card sits in the message box's dock: then it has no frame of its own, the box's is its. */
const Docked = createContext(false);

/** Render with `key={pending.id}` so a new question starts fresh. */
export function InteractionCard({
  sessionId,
  pending,
  docked = false,
  onOpenPlan,
}: {
  sessionId: string;
  pending: PendingInteraction;
  docked?: boolean;
  /** Shows the plan in the Plan pane; without it a plan is read in the card itself. */
  onOpenPlan?: () => void;
}) {
  const [sending, setSending] = useState(false);
  const respond: Respond = (answer) => {
    setSending(true);
    rpc()
      .call('chat.respond', { sessionId, interactionId: pending.id, answer })
      .catch((e: unknown) => {
        // Answered from another window, or the run stopped: the card goes away with the next session event.
        if (errorCode(e) === 'not_waiting') return;
        setSending(false);
        toast.error(describeError(e).message);
      });
  };
  const request = pending.payload as PermissionRequest;
  const card =
    pending.kind === 'question' ? (
      <QuestionCard request={pending.payload as QuestionRequest} sending={sending} respond={respond} />
    ) : pending.kind === 'elicitation' ? (
      <ElicitationCard request={pending.payload as ElicitationRequest} sending={sending} respond={respond} />
    ) : request.toolName === 'ChangeDirectory' ? (
      <FolderRequest request={request} sending={sending} respond={respond} />
    ) : request.toolName === 'AddConnector' ? (
      <ConnectorRequest request={request} sending={sending} respond={respond} />
    ) : request.toolName === 'ExitPlanMode' ? (
      <PlanApproval sessionId={sessionId} request={request} sending={sending} respond={respond} onOpenPlan={onOpenPlan} />
    ) : (
      <PermissionPrompt request={request} sending={sending} respond={respond} />
    );
  return <Docked.Provider value={docked}>{card}</Docked.Provider>;
}

const MOD = isMac ? '⌘' : 'Ctrl';
const SHIFT = isMac ? '⇧' : 'Shift';
const ENTER = isMac ? '↵' : 'Enter';

/** What an ask answers to while it is on screen. Digits count inside the card, outside its text fields. */
interface AskKeys {
  escape?: (() => void) | undefined;
  /** ⌘↵ / Ctrl+Enter: the main action, from the message box as well. */
  mod?: (() => void) | undefined;
  /** ⇧⌘↵: the next one. */
  modShift?: (() => void) | undefined;
  digit?: ((n: number) => void) | undefined;
}

/** The key caps beside an action's name. They are decoration: the button's name carries the label. */
function Caps({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <span aria-hidden className={cn('flex items-center gap-1', className)}>
      {keys.map((k, i) => (
        <Kbd key={i} className="text-current/70">
          {k}
        </Kbd>
      ))}
    </span>
  );
}

/** One of the ask's actions: the label, then its keys. The accessible name is the label alone. */
function Action({
  label,
  caps = [],
  primary = false,
  className,
  ...props
}: { label: string; caps?: readonly string[]; primary?: boolean } & Omit<React.ComponentProps<typeof Button>, 'children' | 'variant' | 'size' | 'aria-label'>) {
  return (
    <Button size="md" variant={primary ? 'primary' : 'secondary'} aria-label={label} className={cn('gap-2.5', className)} {...props}>
      {label}
      {/* In a narrow pane the keys would push the buttons onto two staggered lines; they still work when hidden. */}
      <Caps keys={caps} className="@max-sm:hidden" />
    </Button>
  );
}

/** A button with a chevron segment beside it that opens `menu`. */
function SplitAction({ main, menu, menuLabel }: { main: ReactNode; menu: ReactNode; menuLabel: string }) {
  return (
    <span className="flex items-center">
      {main}
      <Menu>
        <MenuTrigger
          render={
            <Button
              iconOnly
              size="md"
              variant="secondary"
              aria-label={menuLabel}
              className="-ml-px rounded-l-none border-l border-line"
            />
          }
        >
          <Icon icon={ChevronDown} />
        </MenuTrigger>
        <MenuContent className="w-80" align="end">
          {menu}
        </MenuContent>
      </Menu>
    </span>
  );
}

function useAskKeys(card: React.RefObject<HTMLElement | null>, keys: AskKeys): void {
  const latest = useRef(keys);
  useEffect(() => {
    latest.current = keys;
  });
  useEffect(() => {
    // Capture: the message box under the card also answers to Enter and Esc, and the ask comes first.
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const typing = !!target?.closest('input, textarea, [contenteditable="true"]');
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      const keysNow = latest.current;
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.shiftKey && keysNow.escape) {
        // A menu or the slash list that is open closes first.
        if (document.querySelector('[role="menu"], [role="dialog"]') || target?.closest('[aria-expanded="true"]')) return;
        e.preventDefault();
        e.stopPropagation();
        keysNow.escape();
      } else if (e.key === 'Enter' && mod && !e.shiftKey && keysNow.mod) {
        e.preventDefault();
        e.stopPropagation();
        keysNow.mod();
      } else if (e.key === 'Enter' && mod && e.shiftKey && keysNow.modShift) {
        e.preventDefault();
        e.stopPropagation();
        keysNow.modShift();
      } else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.shiftKey && !typing && keysNow.digit && card.current?.contains(target)) {
        e.preventDefault();
        keysNow.digit(Number(e.key));
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [card]);
}

/**
 * A question from the run, in the message box's dock (design/components.md › Asks). It takes focus when it comes up (so Tab
 * reaches its buttons), unless the person is typing somewhere: focus never lands on a button, so an Enter meant for the
 * message box can't approve anything.
 */
function Card({ title, warning, action, keys, children }: { title: string; warning?: string; action?: ReactNode; keys?: AskKeys; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const docked = useContext(Docked);
  useAskKeys(ref, keys ?? {});
  useEffect(() => {
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && (active.isContentEditable || ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.value !== ''));
    if (!typing) ref.current?.focus();
  }, []);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label={title}
      data-ask
      className={cn('overflow-hidden outline-none focus-visible:shadow-[var(--at-shadow-focus)]', !docked && 'rounded-2xl inset-ring inset-ring-line')}
    >
      {warning && (
        <p role="alert" className="flex items-center gap-2 bg-danger-subtle px-4 py-2 text-body text-danger-text">
          <Icon icon={TriangleAlert} />
          {warning}
        </p>
      )}
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex items-start justify-between gap-4">
          <h3 className="min-w-0 text-section-heading text-fg break-words">{title}</h3>
          {action}
        </div>
        {children}
      </div>
    </section>
  );
}

/** "Allow Atelier to run <what it is for>?", or "Allow sub-agent “Write notes” to run this command?" when a sub-agent asks. */
function permissionTitle(request: PermissionRequest, root: string | null): string {
  const input = asRecord(request.input);
  const who = request.agent ? `sub-agent “${request.agent}”` : APP.name;
  switch (request.toolName) {
    case 'Bash': {
      const what = str(input.description).trim();
      return `Allow ${who} to run ${what && !request.agent ? what : 'this command'}?`;
    }
    case 'Edit':
    case 'Write': {
      const verb = request.toolName === 'Edit' ? 'edit' : 'write';
      return `Allow ${who} to ${verb} ${displayPath(str(input.file_path), root)}?`;
    }
    default:
      return `Allow ${who} to use ${request.toolName}?`;
  }
}

/** What the call would do: the command, the change as a diff, or the call's own summary. */
function CallPreview({ request }: { request: PermissionRequest }) {
  const root = useContext(WorkspaceRoot);
  const input = asRecord(request.input);
  const box = 'rounded-lg bg-code-background px-3 py-2 font-mono text-code break-words whitespace-pre-wrap text-fg inset-ring inset-ring-line';
  switch (request.toolName) {
    case 'Bash':
      return (
        <div className="flex flex-col gap-1.5">
          {request.agent && str(input.description) && <p className="text-body text-fg-secondary">{str(input.description)}</p>}
          <pre className={box}>
            <CommandCode command={str(input.command)} />
          </pre>
        </div>
      );
    case 'Edit':
    case 'Write': {
      const path = str(input.file_path);
      const rows = request.toolName === 'Edit' ? editRows(str(input.old_string), str(input.new_string)) : writeRows(str(input.content));
      return <DiffCard rows={rows} language={languageOf(path)} lineNumbers={request.toolName === 'Write'} limit={20} />;
    }
    default: {
      // A connector's tool shows every argument: approving it approves all of them.
      const { verb, target } = summarize({ name: request.toolName, input }, null, root);
      return <pre className={box}>{target && !request.toolName.startsWith('mcp__') ? `${verb} ${target}` : JSON.stringify(input, null, 2)}</pre>;
    }
  }
}

/**
 * Deny, Always allow (for this project; the chevron picks this session or everywhere, each showing the rule it adds)
 * and Allow once. Digits pick them, Esc denies, ⌘↵ allows once and ⇧⌘↵ always allows. Dangerous commands are approved
 * one call at a time. Without a folder (Chat) there is no project: Always allow is for this person everywhere.
 */
function PermissionPrompt({ request, sending, respond }: { request: PermissionRequest; sending: boolean; respond: Respond }) {
  const root = useContext(WorkspaceRoot);
  const inProject = root !== null;
  const rememberable = !request.warning && request.suggestedRule !== '';
  const rule = <code className="font-mono text-caption">{request.suggestedRule}</code>;
  const run = (answer: PermissionAnswer) => !sending && respond(answer);
  const deny = () => run({ behavior: 'deny' });
  const once = () => run({ behavior: 'allow' });
  const always = () => run({ behavior: 'allow', remember: inProject ? 'project' : 'always' });
  const onceDigit = rememberable ? 3 : 2;
  return (
    <Card
      title={permissionTitle(request, root)}
      {...(request.warning ? { warning: request.warning } : {})}
      keys={{
        escape: deny,
        mod: once,
        modShift: rememberable ? always : undefined,
        digit: (n) => (n === 1 ? deny() : n === 2 && rememberable ? always() : n === onceDigit ? once() : undefined),
      }}
    >
      <CallPreview request={request} />
      {/* "Bash needs your approval." says nothing the card doesn't: only a reason with something in it is shown. */}
      {request.reason && !/needs your approval\.?$/.test(request.reason) && <p className="text-footnote text-fg-muted">{request.reason}</p>}
      <div className="@container flex flex-wrap items-center justify-between gap-2">
        <Action label="Deny" caps={['1', 'Esc']} disabled={sending} onClick={deny} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {rememberable && (
            <SplitAction
              menuLabel="Where to always allow"
              main={<Action label="Always allow" caps={['2', SHIFT, MOD, ENTER]} disabled={sending} onClick={always} className="rounded-r-none" />}
              menu={
                <>
                  <MenuItem onClick={() => respond({ behavior: 'allow', remember: 'session' })}>{inProject ? 'Allow for this session' : 'Allow in this conversation'}</MenuItem>
                  {inProject && (
                    <MenuItem description={rule} onClick={() => respond({ behavior: 'allow', remember: 'project' })}>
                      Always allow in this project
                    </MenuItem>
                  )}
                  <MenuItem description={rule} onClick={() => respond({ behavior: 'allow', remember: 'always' })}>
                    Always allow everywhere
                  </MenuItem>
                </>
              }
            />
          )}
          <Action primary label="Allow once" caps={[String(onceDigit), MOD, ENTER]} disabled={sending} onClick={once} />
        </div>
      </div>
    </Card>
  );
}

/**
 * ChangeDirectory: the agent wants the session in another folder. The folder is a field the person can correct, with
 * Browse… on this computer; the session moves there and the conversation goes on.
 */
function FolderRequest({ request, sending, respond }: { request: PermissionRequest; sending: boolean; respond: Respond }) {
  const input = asRecord(request.input);
  const from = str(input.from);
  const host = str(input.host);
  const reason = str(input.reason);
  const [path, setPath] = useState(str(input.path));
  // Folders of this computer can be picked; on an SSH host the path is typed.
  const canBrowse = !!desktop && !host;
  const move = (to: string) => respond({ behavior: 'allow', path: to.trim() });
  const stay = () => !sending && respond({ behavior: 'deny' });
  return (
    <Card
      title={path ? 'Work in another folder?' : 'Choose a folder to work in'}
      keys={{ escape: stay, mod: path.trim() && !sending ? () => move(path) : undefined, digit: (n) => (n === 1 ? stay() : undefined) }}
    >
      {reason && <p className="text-body text-fg-secondary">{reason}</p>}
      <Field label={host ? `Folder on ${host}` : 'Folder'} description={from ? `Now in ${from}` : undefined}>
        <TextField
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && path.trim() && !sending) {
              e.preventDefault();
              move(path);
            }
          }}
          placeholder={host ? '~/projects/app' : '/path/to/folder'}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
      </Field>
      <div className="@container flex flex-wrap items-center justify-between gap-2">
        <Action label="Stay here" caps={['1', 'Esc']} disabled={sending} onClick={stay} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canBrowse && (
            <Button
              size="md"
              disabled={sending}
              onClick={() =>
                void desktop!.folders.pick().then((picked) => {
                  if (picked) setPath(picked);
                })
              }
            >
              Browse…
            </Button>
          )}
          <Action primary label="Move here" caps={[MOD, ENTER]} disabled={sending || !path.trim()} onClick={() => move(path)} />
        </div>
      </div>
    </Card>
  );
}

/**
 * AddConnector: the assistant wants an MCP server the person gave it among their connectors. On a server, an address on
 * this computer's network is allowed here first (this desktop lends it under the connector's id), so the server reaches
 * it through this desktop; a browser can't, and the card says where it can be.
 */
function ConnectorRequest({ request, sending, respond }: { request: PermissionRequest; sending: boolean; respond: Respond }) {
  const input = asRecord(request.input);
  const [id, name, url, reason] = [str(input.id), str(input.name), str(input.url), str(input.reason)];
  const { data: app } = useAppInfo();
  const lending = useLending();
  const [allowing, setAllowing] = useState(false);
  const server = app?.surface === 'web';
  const local = server && isLocalAddress(url);
  const here = local && lending.lends('http');
  const host = URL.parse(url)?.host ?? url;
  const busy = sending || allowing;
  const add = async () => {
    if (busy) return;
    setAllowing(true);
    try {
      if (here) await changeLending({ kind: 'http', id, baseUrl: new URL(url).origin, allowed: true });
      respond({ behavior: 'allow' });
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setAllowing(false);
    }
  };
  const skip = () => !busy && respond({ behavior: 'deny' });
  const where = !server
    ? 'It joins Settings › Connectors on this computer'
    : here
      ? `It joins your connectors, reached through this computer: ${host} is on its network`
      : local
        ? `It joins your connectors. ${host} is on a computer’s network: allow it in Customize › Connectors in the Atelier desktop app on that computer`
        : 'It joins your connectors';
  return (
    <Card title={`Add ${name} to your connectors?`} keys={{ escape: skip, mod: () => void add(), digit: (n) => (n === 1 ? skip() : n === 2 ? void add() : undefined) }}>
      {reason && <p className="text-body text-fg-secondary">{reason}</p>}
      <pre className="rounded-lg bg-code-background px-3 py-2 font-mono text-code break-all whitespace-pre-wrap text-fg inset-ring inset-ring-line">{url}</pre>
      <p className="text-footnote text-fg-muted">{where}, and its tools can be used in this conversation.</p>
      <div className="@container flex flex-wrap items-center justify-between gap-2">
        <Action label="Don’t add" caps={['1', 'Esc']} disabled={busy} onClick={skip} />
        <Action primary label="Add connector" caps={['2', MOD, ENTER]} disabled={busy} onClick={() => void add()} />
      </div>
    </Card>
  );
}

/**
 * ExitPlanMode: "Atelier proposed a plan" with Open plan (the plan itself is read in the Plan
 * pane, where text can be selected to comment on it), then Reject, Revise… (Esc), Accept (⇧⌘↵) and Accept and auto mode
 * (⌘↵) with a chevron for the other modes. Comments made on the plan go with a revision.
 */
function PlanApproval({
  sessionId,
  request,
  sending,
  respond,
  onOpenPlan,
}: {
  sessionId: string;
  request: PermissionRequest;
  sending: boolean;
  respond: Respond;
  onOpenPlan: (() => void) | undefined;
}) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');
  const comments = usePlanComments(sessionId);
  const accept = (mode: 'auto' | 'default' | 'acceptEdits') => {
    if (sending) return;
    planComments.clear(sessionId);
    respond({ behavior: 'allow', mode });
  };
  const reject = () => {
    if (sending) return;
    planComments.clear(sessionId);
    respond({ behavior: 'deny' });
  };
  const message = revisionMessage(feedback, comments);
  const revise = () => {
    if (sending || !message) return;
    planComments.clear(sessionId);
    respond({ behavior: 'deny', message });
  };
  // Revise… and Esc open and close the field; comments already made go with what is typed there.
  const toggleRevising = () => setRevising((r) => !r);
  return (
    <Card
      title={`${APP.name} proposed a plan`}
      action={
        onOpenPlan && (
          <button type="button" onClick={onOpenPlan} className="shrink-0 rounded-xs text-body text-interactive-text underline-offset-2 outline-none hover:underline focus-ring">
            Open plan
          </button>
        )
      }
      keys={{ escape: toggleRevising, mod: () => accept('auto'), modShift: () => accept('default') }}
    >
      {!onOpenPlan && (
        <div className="max-h-[480px] overflow-y-auto rounded-xl px-4 py-3 inset-ring inset-ring-line">
          <Markdown text={str(asRecord(request.input).plan)} streaming={false} />
        </div>
      )}
      {comments.length > 0 && (
        <p className="text-footnote text-fg-muted">
          {comments.length} comment{comments.length === 1 ? '' : 's'} on the plan will go with your revision.
        </p>
      )}
      {revising && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            revise();
          }}
        >
          <TextField
            autoFocus
            aria-label="What should change"
            placeholder="What should change?"
            value={feedback}
            maxLength={1500}
            onChange={(e) => setFeedback(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" size="md" variant="primary" disabled={sending || !message}>
            Send revision
          </Button>
        </form>
      )}
      <div className="@container flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Action label="Reject" disabled={sending} onClick={reject} />
          <Action label="Revise…" caps={['Esc']} aria-expanded={revising} disabled={sending} onClick={toggleRevising} />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Action label="Accept" caps={[SHIFT, MOD, ENTER]} disabled={sending} onClick={() => accept('default')} />
          <SplitAction
            menuLabel="Other ways to accept"
            main={<Action primary label="Accept and auto mode" caps={[MOD, ENTER]} disabled={sending} onClick={() => accept('auto')} className="rounded-r-none" />}
            menu={
              <>
                <MenuItem description="Edits go ahead; other actions still ask" onClick={() => accept('acceptEdits')}>
                  Accept and auto-accept edits
                </MenuItem>
                <MenuItem description="Every edit asks first" onClick={() => accept('default')}>
                  Accept and approve each edit
                </MenuItem>
              </>
            }
          />
        </div>
      </div>
    </Card>
  );
}

/** One question's state: the chosen option labels, and the person's own answer (null while "Other" is not chosen). */
export interface Choice {
  picked: string[];
  other: string | null;
}

/** The answer sent for a question: chosen labels in option order, then the person's own text, joined by ", ". */
export function answerText(question: Question, choice: Choice): string {
  const picked = question.options.map((o) => o.label).filter((label) => choice.picked.includes(label));
  return [...picked, choice.other?.trim() ?? ''].filter(Boolean).join(', ');
}

function QuestionCard({ request, sending, respond }: { request: QuestionRequest; sending: boolean; respond: Respond }) {
  const [choices, setChoices] = useState<Choice[]>(() => request.questions.map(() => ({ picked: [], other: null })));
  const answers = Object.fromEntries(request.questions.map((q, i) => [q.question, answerText(q, choices[i]!)]));
  const complete = Object.values(answers).every(Boolean);
  const update = (index: number, next: (c: Choice) => Choice) => setChoices((cs) => cs.map((c, i) => (i === index ? next(c) : c)));
  const submit = () => !sending && complete && respond({ answers });
  const skip = () => !sending && respond({ answers: {} });
  // With one question its options are numbered, and a digit picks (or, for several answers, toggles) the option.
  const single = request.questions.length === 1 ? request.questions[0]! : null;
  const pick = (n: number) => {
    const o = single?.options[n - 1];
    if (!single || !o) return;
    update(0, (c) => (single.multiSelect ? { ...c, picked: c.picked.includes(o.label) ? c.picked.filter((l) => l !== o.label) : [...c.picked, o.label] } : { picked: [o.label], other: null }));
  };

  return (
    <Card title={request.questions.length === 1 ? 'A question for you' : `${request.questions.length} questions for you`} keys={{ escape: skip, mod: complete ? submit : undefined, digit: single ? pick : undefined }}>
      {request.questions.map((q, i) => {
        const choice = choices[i]!;
        const type = q.multiSelect ? 'checkbox' : 'radio';
        const name = `${request.callId}:${i}`;
        return (
          <fieldset key={i} className="flex flex-col gap-0.5">
            <legend className="mb-2 flex items-center gap-2">
              <Badge>{q.header}</Badge>
              <span className="text-body-strong text-fg">{q.question}</span>
            </legend>
            {q.options.map((o, j) => (
              <Option
                key={j}
                type={type}
                name={name}
                label={o.label}
                number={single ? j + 1 : undefined}
                description={o.description}
                checked={choice.picked.includes(o.label)}
                onChange={() =>
                  update(i, (c) =>
                    q.multiSelect
                      ? { ...c, picked: c.picked.includes(o.label) ? c.picked.filter((l) => l !== o.label) : [...c.picked, o.label] }
                      : { picked: [o.label], other: null },
                  )
                }
              />
            ))}
            <Option
              type={type}
              name={name}
              label="Other"
              checked={choice.other !== null}
              onChange={() => update(i, (c) => (q.multiSelect ? { ...c, other: c.other === null ? '' : null } : { picked: [], other: c.other ?? '' }))}
            />
            {choice.other !== null && (
              <TextField
                autoFocus
                aria-label={`Your answer to “${q.question}”`}
                placeholder="Type your answer"
                value={choice.other}
                maxLength={4000}
                onChange={(e) => update(i, (c) => ({ ...c, other: e.target.value }))}
                className="mt-1 ml-[38px] w-auto"
              />
            )}
          </fieldset>
        );
      })}
      <div className="@container flex flex-wrap items-center justify-between gap-2">
        <Action label="Skip" caps={['Esc']} disabled={sending} onClick={skip} />
        <Action primary label="Submit" caps={[MOD, ENTER]} disabled={!complete || sending} onClick={submit} />
      </div>
    </Card>
  );
}

function Option({
  type,
  name,
  label,
  number,
  description,
  checked,
  onChange,
}: {
  type: 'radio' | 'checkbox';
  name: string;
  label: string;
  /** The digit that picks it (single questions). */
  number?: number | undefined;
  description?: string;
  checked: boolean;
  onChange(): void;
}) {
  return (
    <label
      className={cn(
        // Relative: the visually hidden input is positioned inside its label, not somewhere far down the transcript.
        'relative flex items-start gap-3 rounded-lg px-2.5 py-1.5 has-focus-visible:shadow-[var(--at-shadow-focus)]',
        checked ? 'bg-fill-ghost-selected' : 'hover:bg-fill-ghost-hover',
      )}
    >
      <input type={type} name={name} checked={checked} onChange={onChange} className="sr-only" />
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center text-on-interactive',
          type === 'radio' ? 'rounded-full' : 'rounded-xs',
          checked ? 'bg-interactive' : 'inset-ring inset-ring-line-strong',
        )}
      >
        {checked && (type === 'radio' ? <span className="size-1.5 rounded-full bg-current" /> : <Icon icon={Check} className="size-3" />)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body text-fg">{label}</span>
        {description && <span className="text-footnote text-fg-muted">{description}</span>}
      </span>
      {number !== undefined && <Caps keys={[String(number)]} className="mt-0.5" />}
    </label>
  );
}

/** One field of a connector's form, read from its flat JSON Schema property. */
export interface ElicitationField {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'choice' | 'choices';
  /** Text fields: the input type their `format` asks for. */
  inputType?: 'text' | 'email' | 'url' | 'date' | 'datetime-local';
  /** Choices from `enum` (named by `enumNames`) or from `oneOf`/`anyOf` entries of `{ const, title }`. */
  options?: { value: string; label: string }[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}

type FieldValue = string | boolean | string[];

const INPUT_TYPES: Record<string, ElicitationField['inputType']> = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' };

function choiceOptions(schema: Record<string, unknown>): ElicitationField['options'] {
  const names: unknown[] = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  if (Array.isArray(schema.enum)) return schema.enum.map((v, i) => ({ value: String(v), label: str(names[i]) || String(v) }));
  const variants: unknown[] | undefined = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  return variants?.map(asRecord).map((v) => ({ value: String(v.const), label: str(v.title) || String(v.const) }));
}

/** The form a connector asks for, one field per property; properties of other types are left out. */
export function elicitationFields(schema: Record<string, unknown> | undefined): ElicitationField[] {
  const required = new Set(Array.isArray(schema?.required) ? schema.required.map(String) : []);
  return Object.entries(asRecord(schema?.properties)).flatMap(([name, raw]): ElicitationField[] => {
    const p = asRecord(raw);
    const base = { name, label: str(p.title) || name, required: required.has(name), ...(str(p.description) ? { description: str(p.description) } : {}) };
    const options = choiceOptions(p);
    const items = choiceOptions(asRecord(p.items));
    if (p.type === 'array' && items) return [{ ...base, kind: 'choices', options: items }];
    if (options) return [{ ...base, kind: 'choice', options }];
    if (p.type === 'boolean') return [{ ...base, kind: 'boolean' }];
    if (p.type === 'number' || p.type === 'integer')
      return [{ ...base, kind: p.type, ...(typeof p.minimum === 'number' ? { minimum: p.minimum } : {}), ...(typeof p.maximum === 'number' ? { maximum: p.maximum } : {}) }];
    if (p.type === 'string')
      return [{ ...base, kind: 'text', inputType: (Object.hasOwn(INPUT_TYPES, str(p.format)) && INPUT_TYPES[str(p.format)]) || 'text', ...(typeof p.maxLength === 'number' ? { maxLength: p.maxLength } : {}) }];
    return [];
  });
}

function initialValue(field: ElicitationField, schema: Record<string, unknown> | undefined): FieldValue {
  const given = asRecord(asRecord(schema?.properties)[field.name]).default;
  if (field.kind === 'boolean') return given === true;
  if (field.kind === 'choices') return Array.isArray(given) ? given.map(String) : [];
  return given === undefined ? '' : String(given);
}

/** The answer's content, or null while a required field is empty or a number doesn't parse. */
export function elicitationContent(fields: ElicitationField[], values: Record<string, FieldValue>): NonNullable<ElicitationAnswer['content']> | null {
  const content: NonNullable<ElicitationAnswer['content']> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (typeof value === 'boolean') content[field.name] = value;
    else if (Array.isArray(value) && value.length) content[field.name] = value;
    else if (typeof value === 'string' && value.trim()) {
      if (field.kind === 'number' || field.kind === 'integer') {
        const n = Number(value);
        if (!Number.isFinite(n) || (field.kind === 'integer' && !Number.isInteger(n))) return null;
        content[field.name] = n;
      } else content[field.name] = value;
    } else if (field.required) return null;
  }
  return content;
}

/** A connector asks during a tool call: for a few values (form mode), or to open a link (URL mode). */
function ElicitationCard({ request, sending, respond }: { request: ElicitationRequest; sending: boolean; respond: Respond }) {
  return request.url ? (
    <ElicitationLink request={request} url={request.url} sending={sending} respond={respond} />
  ) : (
    <ElicitationForm request={request} sending={sending} respond={respond} />
  );
}

function ElicitationForm({ request, sending, respond }: { request: ElicitationRequest; sending: boolean; respond: Respond }) {
  const [fields] = useState(() => elicitationFields(request.requestedSchema));
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.name, initialValue(f, request.requestedSchema)])));
  const content = elicitationContent(fields, values);
  const set = (name: string, value: FieldValue) => setValues((v) => ({ ...v, [name]: value }));

  return (
    <Card title={`${request.server} asks for information`}>
      <p className="text-body break-words whitespace-pre-wrap text-fg-secondary">{request.message}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (content) respond({ action: 'accept', content });
        }}
      >
        {fields.map((f) => {
          const value = values[f.name]!;
          const label = (
            <>
              {f.label}
              {!f.required && <span className="font-normal text-fg-muted"> (optional)</span>}
            </>
          );
          if (f.kind === 'boolean')
            return <Option key={f.name} type="checkbox" name={f.name} label={f.label} description={f.description} checked={value === true} onChange={() => set(f.name, value !== true)} />;
          if (f.kind === 'choice' || f.kind === 'choices')
            return (
              <fieldset key={f.name} className="flex flex-col gap-0.5">
                <legend className="mb-1.5 text-body-strong text-fg">{label}</legend>
                {f.description && <p className="mb-1 text-footnote text-fg-muted">{f.description}</p>}
                {f.options!.map((o, j) => {
                  const picked = Array.isArray(value) ? value.includes(o.value) : value === o.value;
                  return (
                    <Option
                      key={j}
                      type={f.kind === 'choice' ? 'radio' : 'checkbox'}
                      name={`${request.server}:${f.name}`}
                      label={o.label}
                      checked={picked}
                      onChange={() => set(f.name, Array.isArray(value) ? (picked ? value.filter((v) => v !== o.value) : [...value, o.value]) : o.value)}
                    />
                  );
                })}
              </fieldset>
            );
          return (
            <Field key={f.name} label={label} description={f.description}>
              <TextField
                type={f.kind === 'text' ? f.inputType : 'number'}
                step={f.kind === 'integer' ? 1 : 'any'}
                min={f.minimum}
                max={f.maximum}
                maxLength={f.maxLength}
                value={value as string}
                onChange={(e) => set(f.name, e.target.value)}
              />
            </Field>
          );
        })}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" variant="primary" disabled={!content || sending}>
            Submit
          </Button>
          <Button size="sm" disabled={sending} onClick={() => respond({ action: 'decline' })}>
            Decline
          </Button>
          <Button size="sm" variant="ghost" disabled={sending} onClick={() => respond({ action: 'cancel' })}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** URL mode: the full address, opened only when the person chooses to. */
function ElicitationLink({ request, url, sending, respond }: { request: ElicitationRequest; url: string; sending: boolean; respond: Respond }) {
  return (
    <Card title={`${request.server} asks you to open a link`}>
      <p className="text-body break-words whitespace-pre-wrap text-fg-secondary">{request.message}</p>
      <div className="flex items-center gap-2 rounded-lg bg-code-background py-1.5 pr-1.5 pl-3 inset-ring inset-ring-line">
        <code className="min-w-0 flex-1 font-mono text-code break-all text-fg">{url}</code>
        <Button size="xs" variant="ghost" leadingIcon={ExternalLink} disabled={!/^https?:\/\//i.test(url)} onClick={() => openExternal(url)}>
          Open link
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={sending} onClick={() => respond({ action: 'accept' })}>
          Accept
        </Button>
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => respond({ action: 'decline' })}>
          Decline
        </Button>
      </div>
    </Card>
  );
}
