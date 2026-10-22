import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStatus, SessionSummary } from '@atelier/protocol';
import { askToNotify, createTaskNotifier, taskEvent } from './notifications.ts';

/** Records what would have reached the operating system. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    FakeNotification.shown.push(this);
  }
  close() {
    this.closed = true;
  }
}

const prefs = (taskFinished = true, permissionNeeded = true) => ({ notifications: { taskFinished, permissionNeeded } });
const task = (status: SessionStatus, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1',
  mode: 'work',
  workspaceId: 'w1',
  permissionMode: null,
  title: 'Summarize the Q3 reports',
  projectId: null,
  model: null,
  effort: null,
  connectorsOff: [],
  research: false,
  status,
  pinnedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

let focused: boolean;
beforeEach(() => {
  FakeNotification.permission = 'granted';
  FakeNotification.shown = [];
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal('Notification', FakeNotification);
  focused = false;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs a task through `statuses` and returns the notifications it raised. */
function run(statuses: SessionStatus[], options: { prefs?: ReturnType<typeof prefs>; extra?: Partial<SessionSummary> } = {}) {
  const notifier = createTaskNotifier();
  const open = vi.fn();
  for (const status of statuses) notifier.update(task(status, options.extra), options.prefs ?? prefs(), open);
  return { shown: FakeNotification.shown.map((n) => [n.title, n.options.body]), open };
}

describe('taskEvent', () => {
  it('tells finishing, failing and waiting apart from repeats and restarts', () => {
    expect(taskEvent('running', 'idle')).toBe('finished');
    expect(taskEvent('waiting', 'idle')).toBe('finished');
    expect(taskEvent('running', 'error')).toBe('failed');
    expect(taskEvent('running', 'waiting')).toBe('input');
    expect(taskEvent('waiting', 'running')).toBeNull();
    expect(taskEvent('idle', 'idle')).toBeNull();
    expect(taskEvent(undefined, 'idle')).toBeNull();
    expect(taskEvent('running', 'interrupted')).toBeNull();
  });
});

describe('task notifications', () => {
  it('says when a task needs the person and when it is done, while the window is in the background', () => {
    expect(run(['idle', 'running', 'waiting', 'running', 'idle']).shown).toEqual([
      ['Cowork task needs your input', 'Summarize the Q3 reports'],
      ['Cowork task finished', 'Summarize the Q3 reports'],
    ]);
    FakeNotification.shown = [];
    expect(run(['running', 'error']).shown).toEqual([['Cowork task failed', 'Summarize the Q3 reports']]);
  });

  it('stays quiet while the window has focus, without permission, for other modes, or when turned off', () => {
    focused = true;
    expect(run(['running', 'idle']).shown).toEqual([]);
    focused = false;
    FakeNotification.permission = 'denied';
    expect(run(['running', 'idle']).shown).toEqual([]);
    FakeNotification.permission = 'granted';
    expect(run(['running', 'idle'], { extra: { mode: 'code' } }).shown).toEqual([]);
    expect(run(['running', 'waiting'], { prefs: prefs(true, false) }).shown).toEqual([]);
    expect(run(['running', 'idle'], { prefs: prefs(false, true) }).shown).toEqual([]);
  });

  it('notifies for a run that started before the window opened', () => {
    const notifier = createTaskNotifier();
    notifier.seed([task('running')]);
    notifier.update(task('idle'), prefs(), vi.fn());
    expect(FakeNotification.shown.map((n) => n.title)).toEqual(['Cowork task finished']);
  });

  it('opens the task and focuses the window on click', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const { open } = run(['running', 'idle']);
    const [notification] = FakeNotification.shown;
    expect(notification!.options.tag).toBe('s1');
    notification!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('s1');
    expect(notification!.closed).toBe(true);
  });
});

describe('askToNotify', () => {
  it('asks once the person wants notifications and has not answered yet', () => {
    FakeNotification.permission = 'default';
    askToNotify(prefs(false, false));
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    askToNotify(prefs());
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    FakeNotification.permission = 'denied';
    askToNotify(prefs());
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
});
