/**
 * Context updates (docs/PROMPTS.md §7): short notes that tell the model what changed since its system prompt was
 * frozen, stored as hidden `context` parts so a replay is exact. Each part records the facts it announced in
 * `state`, so what a branch has been told is read back from the branch itself: editing an earlier message starts a
 * branch that hasn't heard the later notes, and gets them again. A compaction summary restates the state it cut off.
 */
import type { EffortGuidance, Message, Mode, Part, PermissionMode, Todo } from '@atelier/protocol';
import { escapeAttr, escapeTags } from '../prompts/escape.ts';
import { renderNote, type Overrides } from '../prompts/templates.ts';
import { approvedMode, PERMISSION_MODE_LABELS } from '../tools/exit-plan-mode.ts';

/** Announced facts by key: `date`, `model`, `permissionMode`, `skills`, `connectors`, `safeguards`, `git`, `refresher`, `ultracode`, `effort`. */
export type NoteState = Record<string, string>;

/** One turn's notes: the text for the model (empty when nothing changed that it needs to hear) and the facts it records. */
export interface TurnNote {
  text: string;
  state: NoteState;
}

/** What the branch ending in `history` has been told, later parts winning. An approved plan announces its own mode. */
export function announcedState(history: readonly Message[]): NoteState {
  const state: NoteState = {};
  const calls = new Map<string, string>();
  for (const m of history) {
    for (const p of m.parts) {
      if (p.type === 'context' && p.state) Object.assign(state, p.state);
      else if (p.type === 'tool_call') calls.set(p.id, p.name);
      else if (p.type === 'tool_result' && !p.isError && calls.get(p.callId) === 'ExitPlanMode') {
        const mode = approvedMode(p.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
        if (mode) state.permissionMode = mode;
      }
    }
  }
  return state;
}

/** Ultracode as this turn runs it (see `ultracodeNote`). */
export interface UltracodeFacts {
  /** The run shows Ultracode (`shownEffort`): a session whose choice the mode or admin clamps isn't on. */
  on: boolean;
  /** Sub-agents one request may start (the Agent tool refuses more) and the review rounds the note asks for. */
  limits: { maxSubagents: number; maxReviewRounds: number };
}

export interface GitSnapshot {
  branch: string;
  defaultBranch: string;
  changed: number;
  subjects: string[];
}

/** The facts of a top-level session at the start of a turn the person just sent. */
export interface TurnFacts {
  mode: Mode;
  date: { iso: string; long: string };
  model: { ref: string; name: string };
  /** Code and Cowork; chats have no permission mode. */
  permissionMode: PermissionMode | null;
  /** Skills the model may load, with descriptions for the announcement. */
  skills: { name: string; description: string }[];
  /** Connectors whose tools the session has. */
  connectors: string[];
  /** The tools the session offers: a note names only those (docs/PROMPTS.md §0.5). */
  tools: string[];
  /** The rendered safeguards block's hash, empty when safeguards are off. */
  safeguards: string;
  research: boolean;
  /** How full the context window was at the last request, from 0 to 1. */
  contextFill: number;
  /** Code: the repository as it is now, read only when it hasn't been announced. */
  gitSnapshot?(): Promise<GitSnapshot | null>;
  todos: Todo[];
  ultracode?: UltracodeFacts;
  /** What the effort level asks of the model that its own setting can't (protocol `effortGuidance`); null when nothing. */
  effort?: EffortGuidance | null;
}

/** The person turns that need a reminder of the conversation's style in Chat and Cowork. */
const REFRESHER_TURNS = 30;
const ULTRACODE_REMINDER_TURNS = 10;
const EFFORT_REMINDER_TURNS = 10;
const SUBJECT_CHARS = 100;
/** The note announcing each mode but Plan, which has notes of its own. */
const PERMISSION_NOTES: Record<Exclude<PermissionMode, 'plan'>, string> = {
  auto: 'permission-auto',
  default: 'permission-ask',
  acceptEdits: 'permission-accept-edits',
  bypassPermissions: 'permission-bypass',
};

/**
 * The notes for a turn. `prior` is what the model already knows: the frozen system prompt's facts overlaid with what
 * the branch announced since. Only facts that differ from it are recorded.
 */
export async function turnNote(facts: TurnFacts, prior: NoteState, history: readonly Message[], overrides: Overrides): Promise<TurnNote | null> {
  const notes: string[] = [];
  const state: NoteState = {};
  const note = (name: string, vars: Record<string, string> = {}) => notes.push(renderNote(`notes/${name}`, vars, overrides, facts.tools));
  const set = (key: string, value: string) => {
    if (prior[key] !== value) state[key] = value;
  };

  if (prior.date !== undefined && prior.date !== facts.date.iso) note('date', { date: facts.date.long });
  set('date', facts.date.iso);

  if (facts.gitSnapshot && prior.git === undefined) {
    const git = await facts.gitSnapshot();
    if (git) {
      const subjects = git.subjects.map((s) => `- ${escapeTags(s.length > SUBJECT_CHARS ? `${s.slice(0, SUBJECT_CHARS)}…` : s)}`).join('\n');
      note('git-snapshot', { branch: escapeTags(git.branch), default: escapeTags(git.defaultBranch), changed: String(git.changed), subjects });
    }
    set('git', git ? 'sent' : 'none');
  }

  if (prior.model !== undefined && prior.model !== facts.model.ref) note('model', { model: escapeTags(facts.model.name), ref: escapeTags(facts.model.ref), previous: escapeTags(prior.model) });
  set('model', facts.model.ref);

  const mode = facts.permissionMode;
  if (mode) {
    const before = prior.permissionMode;
    if (mode === 'plan') note(before === 'plan' ? 'plan-still-on' : 'plan-on');
    else if (before === 'plan') note('plan-off', { mode: PERMISSION_MODE_LABELS[mode] });
    else if (before !== undefined && before !== mode) note(PERMISSION_NOTES[mode]);
    set('permissionMode', mode);
  }

  const known = new Set(prior.skills?.split('\n') ?? []);
  const added = prior.skills === undefined ? [] : facts.skills.filter((s) => !known.has(s.name));
  if (added.length) note('skills-added', { list: added.map((s) => `- ${escapeTags(s.name)}: ${escapeTags(s.description)}`).join('\n') });
  set('skills', [...new Set([...known, ...facts.skills.map((s) => s.name)])].sort().join('\n'));

  if (prior.connectors !== undefined) {
    const before = new Set(prior.connectors.split('\n').filter(Boolean));
    for (const name of facts.connectors) if (!before.has(name)) note('connector-on', { name: escapeTags(name) });
    for (const name of before) if (!facts.connectors.includes(name)) note('connector-off', { name: escapeTags(name) });
  }
  set('connectors', [...facts.connectors].sort().join('\n'));

  if (prior.safeguards !== undefined && prior.safeguards !== facts.safeguards) note(facts.safeguards ? 'safeguards-changed' : 'workspace-settings-changed');
  set('safeguards', facts.safeguards);

  if (facts.research) note('research');

  if (facts.ultracode) {
    const ultra = ultracodeNote(facts.ultracode, prior, history, overrides, facts.tools);
    if (ultra) {
      notes.push(ultra.text);
      Object.assign(state, ultra.state);
    }
  }

  if (facts.effort !== undefined) {
    const effort = effortNote(facts.effort, prior, history, overrides, facts.tools);
    if (effort) {
      notes.push(effort.text);
      Object.assign(state, effort.state);
    }
  }

  if (refresherDue(facts, history)) {
    const open = facts.todos.filter((t) => t.status !== 'completed').map((t) => escapeTags(t.content));
    note('refresher', { open_tasks: open.join('; ') });
    state.refresher = '1';
  }

  if (!notes.length && !Object.keys(state).length) return null;
  return { text: notes.join('\n\n'), state };
}

/**
 * The Ultracode notes (docs/PROMPTS.md §8): on when it is switched on, a reminder every ten person turns while it
 * stays on, and off when it is switched off or clamped away. Only top-level turns get them (`TurnFacts`); sub-agents
 * never do. A compaction summary only restates that Ultracode is on, so the first turn after one gets the whole note
 * again, unless the tail the compaction kept still holds it (a reminder there isn't enough).
 */
export function ultracodeNote(facts: UltracodeFacts, prior: NoteState, history: readonly Message[], overrides: Overrides, tools: readonly string[] = ['Agent']): TurnNote | null {
  const limits = { maxSubagents: String(facts.limits.maxSubagents), maxReviewRounds: String(facts.limits.maxReviewRounds) };
  // A model without the Agent tool (one that calls no tools) works the same phases and reviews its results itself.
  const render = (name: string) => renderNote(`notes/${name}`, limits, overrides, tools);
  const full = render('ultracode-on');
  // History starts at the latest compaction summary: the full note must be in what follows it.
  const told = history.some((m) => m.kind !== 'compaction_summary' && m.parts.some((p) => p.type === 'context' && p.state?.ultracode === 'on' && p.text.includes(full)));
  if (facts.on && (prior.ultracode !== 'on' || !told)) return { text: full, state: { ultracode: 'on' } };
  if (facts.on && turnsSince(history, 'ultracode') >= ULTRACODE_REMINDER_TURNS) return { text: render('ultracode-still-on'), state: { ultracode: 'on' } };
  if (!facts.on && prior.ultracode === 'on') return { text: render('ultracode-off'), state: { ultracode: 'off' } };
  return null;
}

/**
 * The effort guidance: what the level asks of a model whose own setting can't express it (a thinking switch, no thinking,
 * a level above its range). Said when it starts or changes, again every ten person turns while it holds, and when a
 * compaction cut the note off; "back to the default" when it stops. A level the model's setting has needs no note.
 */
export function effortNote(level: EffortGuidance | null, prior: NoteState, history: readonly Message[], overrides: Overrides, tools: string[] = []): TurnNote | null {
  const render = (name: string) => renderNote(`notes/${name}`, {}, overrides, tools);
  if (!level) return prior.effort !== undefined && prior.effort !== 'none' ? { text: render('effort-normal'), state: { effort: 'none' } } : null;
  // History starts at the latest compaction summary: the note must be in what follows it.
  const told = history.some((m) => m.kind !== 'compaction_summary' && m.parts.some((p) => p.type === 'context' && p.state?.effort === level && p.text !== ''));
  if (prior.effort !== level || !told || turnsSince(history, 'effort') >= EFFORT_REMINDER_TURNS) return { text: render(`effort-${level}`), state: { effort: level } };
  return null;
}

/**
 * A reminder of the conversation's style: right after a compaction, once per compaction cycle when the context is past
 * 60% full, and in Chat and Cowork every thirty person turns.
 */
function refresherDue(facts: TurnFacts, history: readonly Message[]): boolean {
  const reminded = history.some((m) => m.parts.some((p) => p.type === 'context' && p.state?.refresher));
  if (!reminded && (history[0]?.kind === 'compaction_summary' || facts.contextFill >= 0.6)) return true;
  return facts.mode !== 'code' && turnsSince(history, 'refresher') >= REFRESHER_TURNS;
}

/** Person turns after the last part that recorded `key` (or in all of `history`), the one being answered included. */
function turnsSince(history: readonly Message[], key: string): number {
  let turns = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.parts.some((p) => p.type === 'context' && p.state?.[key] !== undefined)) break;
    if (m.role === 'user' && m.kind === 'normal') turns++;
  }
  return turns;
}

/** In-loop: a nudge on a tool result when the task list has unfinished items and hasn't changed in a while. */
export function todoNudge(todos: Todo[], overrides: Overrides): string | null {
  if (!todos.some((t) => t.status !== 'completed')) return null;
  const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' } as const;
  return renderNote('notes/todo-nudge', { todos: todos.map((t) => `- ${mark[t.status]} ${escapeTags(t.content)}`).join('\n') }, overrides);
}

/** The after-compaction part (§3.7): the announced state restated, and what the summary can't carry word for word. */
export function afterCompaction(
  input: { state: NoteState; models: Map<string, string>; plan: string | null; skills: { name: string; text: string }[]; files: string[] },
  overrides: Overrides,
): Part {
  const { state } = input;
  const facts = [
    state.model && `the model is ${input.models.get(state.model) ?? state.model} (${state.model})`,
    state.permissionMode && `the permission mode is ${PERMISSION_MODE_LABELS[state.permissionMode as PermissionMode]}`,
    state.ultracode === 'on' && 'Ultracode is on',
    "replies follow the language of the person's latest message",
  ].filter(Boolean);
  const text = renderNote(
    'notes/after-compaction',
    {
      state: facts.join('; '),
      plan: input.plan ? escapeTags(input.plan) : '',
      skills: input.skills.map((s) => `<skill name="${escapeAttr(s.name)}">\n${escapeTags(s.text)}\n</skill>`).join('\n\n'),
      files: input.files.map(escapeTags).join(', '),
    },
    overrides,
  );
  // The refresher marker is left out, so the first turn after the summary gets one.
  const restated = { ...state };
  delete restated.refresher;
  return { type: 'context', text, state: restated };
}
