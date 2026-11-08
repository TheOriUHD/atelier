/**
 * What the run waits on, asked in the terminal (ARCHITECTURE §25): a permission (with the command, the change or the
 * address, and a red warning for a dangerous command), questions with options, a plan to approve, a folder to move to,
 * a connector to add, a connector's own form. Each answer goes back with `chat.respond`.
 */
import { Box, Text } from 'ink';
import { useState } from 'react';
import { editRows } from '@atelier/client';
import type { ElicitationAnswer, PendingInteraction, PermissionAnswer, PermissionRequest, QuestionAnswer, QuestionRequest, ElicitationRequest } from '@atelier/protocol';
import { Choices, Panel, TextLine, type Choice } from './inputs.tsx';
import { renderMarkdown } from './markdown.ts';
import { diffLines, displayPath, type ViewContext } from './views.tsx';

type Answer = PermissionAnswer | QuestionAnswer | ElicitationAnswer;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The question a permission prompt asks, and what it shows of the call. */
export function permissionText(req: PermissionRequest, ctx: ViewContext): { title: string; body: string[] } {
  const { paint } = ctx;
  const input = asRecord(req.input);
  const path = displayPath(str(input.file_path) || str(input.path), ctx.root);
  switch (req.toolName) {
    case 'Bash': {
      const command = str(input.command);
      return { title: 'Run this command?', body: [...command.split('\n').map((l) => `  ${paint.fg('secondary', l)}`), ...(str(input.description) ? [paint.fg('muted', `  ${str(input.description)}`)] : [])] };
    }
    case 'Edit':
      return { title: `Edit ${path}?`, body: diffLines(editRows(str(input.old_string), str(input.new_string)), paint, 30, path.slice(path.lastIndexOf('.') + 1)) };
    case 'Write': {
      const lines = str(input.content).split('\n');
      return { title: `Create ${path}?`, body: [...lines.slice(0, 12).map((l) => `  ${paint.fg('added', l)}`), ...(lines.length > 12 ? [paint.fg('muted', `  … ${lines.length - 12} more lines`)] : [])] };
    }
    case 'Read':
    case 'Glob':
    case 'Grep':
      return { title: `Read ${path || str(input.pattern)}?`, body: [] };
    case 'WebFetch':
      return { title: `Fetch ${str(input.url)}?`, body: [] };
    case 'Agent':
      return { title: `Start a sub-agent: ${str(input.description)}?`, body: [] };
    default: {
      const preview = JSON.stringify(req.input ?? {}, null, 2).split('\n').slice(0, 12);
      const name = req.toolName.startsWith('mcp__') ? req.toolName.split('__').slice(1).join(' › ') : req.toolName;
      return { title: `Use ${name}?`, body: preview.map((l) => `  ${paint.fg('muted', l)}`) };
    }
  }
}

function PermissionPrompt({ req, ctx, respond }: { req: PermissionRequest; ctx: ViewContext; respond(a: PermissionAnswer): void }) {
  const { paint } = ctx;
  const [telling, setTelling] = useState(false);
  const { title, body } = permissionText(req, ctx);
  const remember = !req.warning && req.suggestedRule !== '';
  const choices: Choice<string>[] = [
    { value: 'once', label: 'Yes' },
    ...(remember
      ? [
          { value: 'session', label: 'Yes, and allow it for this session', hint: req.suggestedRule },
          { value: 'project', label: 'Yes, always in this project', hint: `${req.suggestedRule} · saved in .atelier/settings.local.json` },
          { value: 'always', label: 'Yes, always, everywhere', hint: `${req.suggestedRule} · saved in your own rules` },
        ]
      : []),
    { value: 'no', label: 'No, and tell Atelier what to do instead', hint: 'esc' },
  ];
  return (
    <Panel paint={paint} title={title} tone={req.warning ? 'bad' : 'warn'}>
      {req.agent && <Text>{paint.fg('muted', `A sub-agent asks: ${req.agent}`)}</Text>}
      {body.length > 0 && <Text>{body.join('\n')}</Text>}
      {req.warning && <Text>{paint.fg('bad', `⚠ ${req.warning}`)}</Text>}
      <Text>{paint.fg('muted', req.reason)}</Text>
      <Box marginTop={1} flexDirection="column">
        {telling ? (
          <TextLine paint={paint} placeholder="What should it do instead? (Enter to send, empty just says no)" onSubmit={(message) => respond({ behavior: 'deny', ...(message.trim() ? { message: message.trim() } : {}) })} onCancel={() => setTelling(false)} />
        ) : (
          <Choices
            paint={paint}
            choices={choices}
            onCancel={() => respond({ behavior: 'deny' })}
            onPick={(v) => {
              if (v === 'no') return setTelling(true);
              respond({ behavior: 'allow', ...(v === 'once' ? {} : { remember: v as 'session' | 'project' | 'always' }) });
            }}
          />
        )}
      </Box>
    </Panel>
  );
}

function PlanPrompt({ req, ctx, respond }: { req: PermissionRequest; ctx: ViewContext; respond(a: PermissionAnswer): void }) {
  const { paint } = ctx;
  const [telling, setTelling] = useState(false);
  const plan = str(asRecord(req.input).plan);
  return (
    <Panel paint={paint} title="Here is the plan. Go ahead?" tone="info">
      <Text>{renderMarkdown(plan, paint, ctx.columns - 6)}</Text>
      <Box marginTop={1} flexDirection="column">
        {telling ? (
          <TextLine paint={paint} placeholder="What should change in the plan?" onSubmit={(message) => respond({ behavior: 'deny', ...(message.trim() ? { message: message.trim() } : {}) })} onCancel={() => setTelling(false)} />
        ) : (
          <Choices
            paint={paint}
            choices={[
              { value: 'auto', label: 'Yes, and work in Auto', hint: 'a reviewing model checks what would ask' },
              { value: 'acceptEdits', label: 'Yes, and accept edits', hint: 'commands still ask' },
              { value: 'default', label: 'Yes, and ask before each change' },
              { value: 'no', label: 'No, keep planning', hint: 'say what should change' },
            ]}
            onCancel={() => respond({ behavior: 'deny' })}
            onPick={(v) => (v === 'no' ? setTelling(true) : respond({ behavior: 'allow', mode: v as 'auto' | 'acceptEdits' | 'default' }))}
          />
        )}
      </Box>
    </Panel>
  );
}

function FolderPrompt({ req, ctx, respond }: { req: PermissionRequest; ctx: ViewContext; respond(a: PermissionAnswer): void }) {
  const path = str(asRecord(req.input).path);
  const [typing, setTyping] = useState(false);
  return (
    <Panel paint={ctx.paint} title={`Move this session to ${path || 'another folder'}?`} tone="warn">
      <Text>{ctx.paint.fg('muted', str(asRecord(req.input).reason) || req.reason)}</Text>
      {typing ? (
        <TextLine paint={ctx.paint} initial={path} onSubmit={(p) => respond({ behavior: 'allow', path: p.trim() || path })} onCancel={() => setTyping(false)} />
      ) : (
        <Choices
          paint={ctx.paint}
          choices={[
            { value: 'yes', label: 'Yes, move there' },
            { value: 'other', label: 'Yes, but to another folder…' },
            { value: 'no', label: 'No, stay here' },
          ]}
          onCancel={() => respond({ behavior: 'deny' })}
          onPick={(v) => (v === 'yes' ? respond({ behavior: 'allow', ...(path ? { path } : {}) }) : v === 'other' ? setTyping(true) : respond({ behavior: 'deny' }))}
        />
      )}
    </Panel>
  );
}

function QuestionPrompt({ req, ctx, respond }: { req: QuestionRequest; ctx: ViewContext; respond(a: QuestionAnswer): void }) {
  const { paint } = ctx;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [other, setOther] = useState(false);
  const q = req.questions[index]!;
  const next = (answer: string) => {
    const all = { ...answers, [q.question]: answer };
    setAnswers(all);
    setPicked(new Set());
    setOther(false);
    if (index + 1 < req.questions.length) setIndex(index + 1);
    else respond({ answers: all });
  };
  const choices: Choice<number>[] = [
    ...q.options.map((o, i) => ({ value: i, label: q.multiSelect ? `${picked.has(i) ? '☒' : '☐'} ${o.label}` : o.label, hint: o.description })),
    { value: -1, label: 'Something else…', hint: 'type your own answer' },
    ...(q.multiSelect ? [{ value: -2, label: 'Done', hint: picked.size ? q.options.filter((_, i) => picked.has(i)).map((o) => o.label).join(', ') : 'pick at least one' }] : []),
  ];
  return (
    <Panel paint={paint} title={`${q.header ? `${q.header} · ` : ''}${q.question}`} tone="info">
      {req.questions.length > 1 && <Text>{paint.fg('muted', `Question ${index + 1} of ${req.questions.length}`)}</Text>}
      {other ? (
        <TextLine paint={paint} placeholder="Your answer" onSubmit={(t) => t.trim() && next(t.trim())} onCancel={() => setOther(false)} />
      ) : (
        <Choices
          key={index}
          paint={paint}
          choices={choices}
          showHints="all"
          onCancel={() => respond({ answers: {} })}
          onPick={(v) => {
            if (v === -1) return setOther(true);
            if (v === -2) return picked.size && next(q.options.filter((_, i) => picked.has(i)).map((o) => o.label).join(', '));
            if (!q.multiSelect) return next(q.options[v]!.label);
            const s = new Set(picked);
            if (s.has(v)) s.delete(v);
            else s.add(v);
            setPicked(s);
          }}
        />
      )}
      <Text>{paint.fg('faint', 'esc skips the questions')}</Text>
    </Panel>
  );
}

function ElicitationPrompt({ req, ctx, respond }: { req: ElicitationRequest; ctx: ViewContext; respond(a: ElicitationAnswer): void }) {
  const { paint } = ctx;
  const properties = asRecord(asRecord(req.requestedSchema).properties);
  const fields = Object.entries(properties);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [field, setField] = useState(-1);
  if (field >= 0 && field < fields.length) {
    const [name, schema] = fields[field]!;
    const s = asRecord(schema);
    return (
      <Panel paint={paint} title={`${req.server}: ${str(s.title) || name}`} tone="info">
        {str(s.description) && <Text>{paint.fg('muted', str(s.description))}</Text>}
        <TextLine
          key={name}
          paint={paint}
          onSubmit={(t) => {
            const value = s.type === 'number' || s.type === 'integer' ? Number(t) : s.type === 'boolean' ? /^(y|yes|true|1)$/i.test(t) : t;
            setValues({ ...values, [name]: value });
            setField(field + 1 < fields.length ? field + 1 : fields.length);
          }}
          onCancel={() => respond({ action: 'cancel' })}
        />
      </Panel>
    );
  }
  return (
    <Panel paint={paint} title={`${req.server} asks`} tone="info">
      <Text>{req.message}</Text>
      {req.url && <Text>{paint.fg('info', req.url)}</Text>}
      <Choices
        paint={paint}
        choices={[
          { value: 'accept', label: field >= fields.length || !fields.length ? (req.url ? 'I opened it, go on' : 'Send') : 'Fill it in…' },
          { value: 'decline', label: 'Decline' },
          { value: 'cancel', label: 'Cancel' },
        ]}
        onCancel={() => respond({ action: 'cancel' })}
        onPick={(v) => {
          if (v === 'accept' && fields.length && field < fields.length) return setField(0);
          respond(v === 'accept' ? { action: 'accept', ...(fields.length ? { content: values } : {}) } : { action: v as 'decline' | 'cancel' });
        }}
      />
    </Panel>
  );
}

function ConnectorPrompt({ req, ctx, respond }: { req: PermissionRequest; ctx: ViewContext; respond(a: PermissionAnswer): void }) {
  const input = asRecord(req.input);
  return (
    <Panel paint={ctx.paint} title={`Add the connector ${str(input.name) || str(input.url)}?`} tone="warn">
      <Text>{ctx.paint.fg('secondary', str(input.url))}</Text>
      <Text>{ctx.paint.fg('muted', 'Its tools join this session from the next step.')}</Text>
      <Choices
        paint={ctx.paint}
        choices={[
          { value: 'yes', label: 'Yes, add it' },
          { value: 'no', label: 'No' },
        ]}
        onCancel={() => respond({ behavior: 'deny' })}
        onPick={(v) => respond({ behavior: v === 'yes' ? 'allow' : 'deny' })}
      />
    </Panel>
  );
}

/** The prompt for what the run waits on. */
export function PendingPrompt({ pending, ctx, respond }: { pending: PendingInteraction; ctx: ViewContext; respond(answer: Answer): void }) {
  if (pending.kind === 'question') return <QuestionPrompt key={pending.id} req={pending.payload as QuestionRequest} ctx={ctx} respond={respond} />;
  if (pending.kind === 'elicitation') return <ElicitationPrompt key={pending.id} req={pending.payload as ElicitationRequest} ctx={ctx} respond={respond} />;
  const req = pending.payload as PermissionRequest;
  if (req.toolName === 'ExitPlanMode') return <PlanPrompt key={pending.id} req={req} ctx={ctx} respond={respond} />;
  if (req.toolName === 'ChangeDirectory') return <FolderPrompt key={pending.id} req={req} ctx={ctx} respond={respond} />;
  if (req.toolName === 'AddConnector') return <ConnectorPrompt key={pending.id} req={req} ctx={ctx} respond={respond} />;
  return <PermissionPrompt key={pending.id} req={req} ctx={ctx} respond={respond} />;
}
