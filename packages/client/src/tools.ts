/**
 * What a tool call did, in words: "Read src/app.ts · 40 lines", "Ran 3 commands, read app.ts", how a Bash command
 * ended. The app's tool cards and the terminal's transcript say the same things.
 */
import type { BackgroundTask, Todo, ToolCallPart, ToolResultPart } from '@atelier/protocol';
import { messageTargetKind } from './activity.ts';
import { editRows, writeRows } from './diff.ts';
import { displayPath } from './paths.ts';
import { inputPreview } from './phase.ts';
import { parseSearchResult } from './search-result.ts';

export const asRecord = (input: unknown): Record<string, unknown> => (input && typeof input === 'object' ? (input as Record<string, unknown>) : {});
export const str = (value: unknown): string => (typeof value === 'string' ? value : '');
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function resultText(result: ToolResultPart | undefined): string {
  return result?.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n') ?? '';
}

/** A Read of a folder: it answered with the folder's entries ("src is a directory:", files.ts) rather than a file. */
export function folderRead(step: { call: ToolCallPart | Pick<ToolCallPart, 'name'>; result?: ToolResultPart | undefined }): boolean {
  if (step.call.name !== 'Read' || !step.result || step.result.isError) return false;
  return /^.* is (?:a directory:|an empty directory\.)/.test(resultText(step.result));
}

/** A Read that brought an image: it was looked at. */
export function imageRead(step: { call: ToolCallPart | Pick<ToolCallPart, 'name'>; result?: ToolResultPart | undefined }): boolean {
  return step.call.name === 'Read' && !step.result?.isError && !!step.result?.content.some((part) => part.type === 'image');
}

/** The call as its row and summary word it: an image looked at, a folder listed, else as it was made. */
export function shownCall<C extends Pick<ToolCallPart, 'name' | 'input'>>(step: { call: C; result?: ToolResultPart | undefined }): C {
  if (imageRead(step)) return { ...step.call, name: 'ViewedImage' };
  if (folderRead(step)) return { ...step.call, name: 'ListedFolder' };
  return step.call;
}

/** A folder as the transcript names it: the workspace itself is "the folder", another by its path. */
export function folderName(path: string, root: string | null): string {
  const shown = displayPath(path, root).replace(/[\\/]+$/, '');
  return !shown || shown === '.' || shown === '~' || (root && (path === root || path === `${root}/`)) ? 'the folder' : shown;
}


/** The id Bash gave a command it started in the background, from its result. */
export function backgroundId(result: ToolResultPart | undefined): string | null {
  return /Started in the background with ID (\S+?)\./.exec(resultText(result))?.[1] ?? null;
}


const TASK_STATUS: Record<Exclude<BackgroundTask['status'], 'running'>, string> = { done: 'Done', failed: 'Failed', stopped: 'Stopped' };

/** "Done", "Exit code 1", "Stopped": how a finished task ended. */
export function taskOutcome(task: BackgroundTask): string {
  if (task.status === 'running') return 'Running';
  if (task.status === 'failed' && task.exitCode !== null) return `Exit code ${task.exitCode}`;
  return TASK_STATUS[task.status];
}

/** "2 background commands completed, 1 running". */
export function backgroundSummary(completed: number, running: number): string {
  const noun = (n: number) => `${n} background ${n === 1 ? 'command' : 'commands'}`;
  if (!completed) return `${noun(running)} running`;
  return running ? `${noun(completed)} completed, ${running} running` : `${noun(completed)} completed`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('#', String(n)));

/**
 * What a run of tool calls did, in a line: "Ran 34 commands, read app.ts", "Created 2 files, ran 5 commands". Phrases
 * come in the order their tools were first used.
 */
export function activitySummary(calls: readonly Pick<ToolCallPart, 'name' | 'input'>[], root: string | null): string {
  const groups = new Map<string, Pick<ToolCallPart, 'name' | 'input'>[]>();
  for (const call of calls) {
    const group = call.name === 'Glob' ? 'Grep' : call.name;
    groups.set(group, [...(groups.get(group) ?? []), call]);
  }
  const file = (call: Pick<ToolCallPart, 'input'>) => {
    const path = displayPath(str(asRecord(call.input).file_path), root);
    return path.slice(path.lastIndexOf('/') + 1);
  };
  const files = (list: Pick<ToolCallPart, 'input'>[]) => [...new Set(list.map(file))];
  const phrases = [...groups].map(([name, list]) => {
    const n = list.length;
    switch (name) {
      case 'Bash':
        return plural(n, 'ran a command', 'ran # commands');
      case 'ViewedImage':
        return files(list).length === 1 ? `looked at ${file(list[0]!)}` : `looked at ${files(list).length} images`;
      case 'ListedFolder': {
        const folders = [...new Set(list.map((c) => folderName(str(asRecord(c.input).file_path), root)))];
        return folders.length === 1 ? `listed ${folders[0]}` : `listed ${folders.length} folders`;
      }
      case 'Read':
        return files(list).length === 1 ? `read ${file(list[0]!)}` : `read ${files(list).length} files`;
      case 'Write':
        return files(list).length === 1 ? `created ${file(list[0]!)}` : `created ${files(list).length} files`;
      case 'Edit':
        return files(list).length === 1 ? `edited ${file(list[0]!)}` : `edited ${files(list).length} files`;
      case 'SaveImage':
        return files(list).length === 1 ? `saved ${file(list[0]!)}` : `saved ${files(list).length} images`;
      case 'SaveVideo':
        return files(list).length === 1 ? `saved ${file(list[0]!)}` : `saved ${files(list).length} videos`;
      case 'SaveAudio':
        return files(list).length === 1 ? `saved ${file(list[0]!)}` : `saved ${files(list).length} sounds`;
      case 'Grep':
        return plural(n, 'searched the code', 'searched the code # times');
      case 'WebSearch':
        return plural(n, 'searched the web', 'searched the web # times');
      case 'WebFetch':
        return plural(n, 'fetched a page', 'fetched # pages');
      case 'BashOutput':
        return 'checked command output';
      case 'KillShell':
        return plural(n, 'stopped a command', 'stopped # commands');
      case 'TaskStop':
        return plural(n, 'stopped a background task', 'stopped # background tasks');
      case 'ChangeDirectory':
        return 'changed folder';
      case 'AddConnector':
        return plural(n, 'added a connector', 'added # connectors');
      case 'ComputerAccess':
        return 'asked to use apps';
      case 'ComputerApps':
        return 'looked up apps';
      case 'OpenApp':
        return n === 1 ? `opened ${str(asRecord(list[0]!.input).app)}` : `opened ${n} apps`;
      case 'Screenshot':
        return plural(n, 'took a screenshot', 'took # screenshots');
      case 'FullControl':
        return list.some((c) => asRecord(c.input).action === 'request') ? 'took over the mouse and keyboard' : 'handed back the mouse and keyboard';
      case 'ComputerAction': {
        const actions = list.reduce((sum, c) => sum + computerActions(c.input).length, 0);
        return plural(actions, 'used the computer once', 'used the computer # times');
      }
      case 'SendMessage':
        return n === 1 ? `messaged ${messageTargetKind(str(asRecord(list[0]!.input).to))}` : `sent ${n} messages`;
      case 'ListSessions':
        return 'looked up sessions';
      case 'Time':
        return 'checked the time';
      case 'Usage':
        return 'checked usage';
      case 'TodoWrite':
        return 'updated the task list';
      default:
        return `used ${name}`;
    }
  });
  const line = phrases.join(', ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function computerActions(input: unknown): Record<string, unknown>[] {
  const actions = asRecord(input).actions;
  return Array.isArray(actions) ? actions.map(asRecord) : [];
}

const ACTION_WORDS: Record<string, string> = {
  left_click: 'Clicked',
  right_click: 'Right-clicked',
  middle_click: 'Middle-clicked',
  double_click: 'Double-clicked',
  triple_click: 'Triple-clicked',
  mouse_move: 'Moved the pointer',
  left_click_drag: 'Dragged',
  scroll: 'Scrolled',
  type: 'Typed',
  key: 'Pressed',
  wait: 'Waited',
  screenshot: 'Took a screenshot',
  zoom: 'Zoomed in',
  cursor_position: 'Checked the pointer',
};

const ACTION_WORDS_AHEAD: Record<string, string> = {
  left_click: 'Click',
  right_click: 'Right-click',
  middle_click: 'Middle-click',
  double_click: 'Double-click',
  triple_click: 'Triple-click',
  mouse_move: 'Move the pointer',
  left_click_drag: 'Drag',
  scroll: 'Scroll',
  type: 'Type',
  key: 'Press',
  wait: 'Wait',
  screenshot: 'Take a screenshot',
  zoom: 'Zoom in',
  cursor_position: 'Check the pointer',
};

/**
 * One ComputerAction step in words: its own summary when it gave one, else what it is, done ("Pressed cmd+s") or, on a
 * prompt, ahead ("Press cmd+s").
 */
export function actionWords(action: Record<string, unknown>, ahead = false): string {
  if (str(action.summary)) return str(action.summary);
  const words = (ahead ? ACTION_WORDS_AHEAD : ACTION_WORDS)[str(action.action)] ?? str(action.action);
  return action.action === 'key' ? `${words} ${str(action.text)}` : words;
}

/** Lines an Edit or Write call adds and removes. */
export function changedLines(call: Pick<ToolCallPart, 'name' | 'input'>): { added: number; removed: number } {
  const input = asRecord(call.input);
  const rows = call.name === 'Edit' ? editRows(str(input.old_string), str(input.new_string)) : call.name === 'Write' ? writeRows(str(input.content)) : [];
  return { added: rows.filter((r) => r.kind === 'add').length, removed: rows.filter((r) => r.kind === 'remove').length };
}


/** Lines of a listing, without the note a tool appends after a blank line ("[Results truncated …]"). */
const listed = (text: string) => text.split('\n\n')[0]!.split('\n').filter(Boolean).length;

function globMeta(result: string): string {
  return result.startsWith('No files found') ? 'no files' : count(listed(result), 'file');
}

function grepMeta(result: string): string {
  if (/^No (files|matches) found/.test(result)) return 'no matches';
  const files = /^Found (\d+) files/.exec(result);
  if (files) return count(Number(files[1]), 'file');
  const counts = /(\d+) matching lines in (\d+) files/.exec(result);
  if (counts) return `${count(Number(counts[1]), 'match', 'matches')} in ${count(Number(counts[2]), 'file')}`;
  return count(listed(result), 'line');
}

export interface ToolSummary {
  verb: string;
  target: string;
  meta?: string;
}

/** What a call did, to what, and (once it has a result) what came back: "Read src/app.ts · 40 lines". */
export function summarize(call: Pick<ToolCallPart, 'name' | 'input'>, result: string | null, root: string | null): ToolSummary {
  const input = asRecord(call.input);
  switch (call.name) {
    case 'ViewedImage':
      return { verb: 'Looked at', target: displayPath(str(input.file_path), root) };
    case 'ListedFolder': {
      // The entries under the first line, without the note that a long folder was cut short.
      const entries = (result ?? '').split('\n').slice(1).filter((line) => line && !line.startsWith('[Only the first'));
      return { verb: 'Listed', target: folderName(str(input.file_path), root), ...(result != null ? { meta: entries.length ? count(entries.length, 'item') : 'empty' } : {}) };
    }
    case 'Read': {
      const lines = result?.match(/^\s*\d+\t/gm)?.length ?? 0;
      return { verb: 'Read', target: displayPath(str(input.file_path), root), ...(lines ? { meta: count(lines, 'line') } : {}) };
    }
    case 'Glob':
      return { verb: 'Searched for', target: str(input.pattern), ...(result != null ? { meta: globMeta(result) } : {}) };
    case 'Grep': {
      const where = str(input.path) ? ` in ${displayPath(str(input.path), root)}` : '';
      return { verb: 'Searched for', target: `${str(input.pattern)}${where}`, ...(result != null ? { meta: grepMeta(result) } : {}) };
    }
    case 'Edit':
    case 'Write':
      return { verb: call.name, target: displayPath(str(input.file_path), root) };
    case 'SaveImage':
    case 'SaveVideo':
    case 'SaveAudio':
      return { verb: result === null ? 'Save' : 'Saved', target: displayPath(str(input.file_path), root) };
    case 'Bash':
      return { verb: 'Ran', target: str(input.description) || str(input.command) };
    case 'BashOutput':
      return { verb: 'Checked the output of', target: str(input.bash_id) };
    case 'KillShell':
      return { verb: 'Stopped', target: str(input.shell_id) };
    case 'TaskStop': {
      const ids = Array.isArray(input.task_ids) ? input.task_ids.length : 0;
      return { verb: 'Stopped', target: input.all === true ? 'all background tasks' : ids > 1 ? `${ids} background tasks` : str(input.task_id) || str(Array.isArray(input.task_ids) ? input.task_ids[0] : '') };
    }
    case 'ChangeDirectory':
      return { verb: 'Moved to', target: str(input.path) || 'another folder' };
    case 'AddConnector':
      return { verb: 'Added connector', target: str(input.name) || str(input.url) };
    case 'ComputerAccess':
      return { verb: 'Asked to use', target: (Array.isArray(input.apps) ? input.apps : []).map(str).filter(Boolean).join(', ') };
    case 'ComputerApps':
      return { verb: 'Looked up apps', target: str(input.query) };
    case 'OpenApp':
      return { verb: 'Opened', target: str(input.app) };
    case 'Screenshot':
      return { verb: 'Took a screenshot', target: str(input.display) };
    case 'FullControl':
      return input.action === 'release' ? { verb: 'Handed back the mouse and keyboard', target: '' } : { verb: 'Took over the mouse and keyboard', target: '' };
    case 'ComputerAction': {
      const actions = computerActions(input);
      return { verb: actions.length === 1 ? actionWords(actions[0]!) : `${actions.length} actions:`, target: actions.length === 1 ? '' : actions.map((a) => actionWords(a)).join(', ') };
    }
    case 'WebFetch':
      return { verb: 'Fetched', target: str(input.url) };
    case 'WebSearch': {
      const view = result != null ? parseSearchResult(result) : null;
      const meta = view?.via ? `${count(view.rows.length, 'result')} · ${view.via}` : view && view.rows.length === 0 && result?.startsWith('No results') ? 'no results' : undefined;
      return { verb: 'Searched the web for', target: str(input.query), ...(meta ? { meta } : {}) };
    }
    case 'TodoWrite': {
      const todos = (input.todos ?? []) as Todo[];
      return { verb: 'Updated the task list', target: '', meta: `${todos.filter((t) => t.status === 'completed').length} of ${todos.length} done` };
    }
    case 'AskUser':
      return { verb: 'Asked', target: count(Array.isArray(input.questions) ? input.questions.length : 0, 'question') };
    case 'Agent':
      return { verb: 'Delegated', target: str(input.description) };
    case 'SendMessage': {
      const sent = result != null ? messageReceipt(result) : null;
      return { verb: `Messaged ${sent?.kind ?? messageTargetKind(str(input.to))}`, target: '', ...(sent ? { meta: sent.title } : {}) };
    }
    case 'ListSessions':
      return { verb: 'Looked up sessions', target: str(input.query) };
    case 'Time':
      return { verb: 'Checked', target: 'the time' };
    case 'Usage':
      return { verb: 'Checked', target: 'plan usage' };
    default:
      return { verb: call.name, target: inputPreview(input) };
  }
}


/** Splits a Bash result into the command's output and the exit status the tool appends after a blank line. */
export function bashResult(text: string): { output: string; exitCode: number | null; note: string | null } {
  const cut = text.lastIndexOf('\n\n');
  const notes = text.slice(cut + 2);
  const exit = /^Exit code (-?\d+)\.$/m.exec(notes);
  if (cut === -1 || (!exit && !notes.startsWith('Timed out'))) return { output: text, exitCode: null, note: null };
  const output = text.slice(0, cut);
  return { output: output === '(no output)' ? '' : output, exitCode: exit ? Number(exit[1]) : null, note: exit ? null : notes.split('\n')[0]! };
}


/** Where a SendMessage result says the message went: "Sent to the session "Fix login" (id …)." and what happens next. */
export function messageReceipt(result: string): { kind: string; title: string; id: string; status: string } | null {
  const m = /^Sent to (the session|the sub-agent|your parent session) "([\s\S]*)" \((?:id|task) (\S+)\)\.\s*([\s\S]*)$/.exec(result);
  if (!m) return null;
  const kind = { 'the session': 'another session', 'the sub-agent': 'a sub-agent', 'your parent session': 'the parent session' }[m[1]!]!;
  return { kind, title: m[2]!, id: m[3]!, status: m[4]!.trim() };
}

