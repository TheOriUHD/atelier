/**
 * The terminal app's session screen (ARCHITECTURE §25), laid out like Claude Code's: the header with Pip, the transcript
 * (printed into the scrollback as it finishes), what is still going on (streaming text, running steps, the status
 * line), then the prompt the run waits on or the message box, and the footer. Everything goes through the backend's
 * RPC contract and the live sessions the app uses.
 */
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { Box, Static, Text, useAnimation, useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { initialLiveState, liveContext, liveStatus, type LiveSessionState } from '@atelier/client';
import { effortChoices, shownEffort, type Effort, type ModelInfo, type Part, type PermissionMode, type WorkspaceSummary } from '@atelier/protocol';
import { drawPip, PIP_HELLO } from '../art/mascot.ts';
import { TIPS } from '../art/words.ts';
import { updateConfig, type CliConfig } from '../config.ts';
import type { Connected } from '../connection/connect.ts';
import { describe } from '../connection/connect.ts';
import type { CliPaths } from '../paths.ts';
import { VERSION } from '../runtime.ts';
import type { Paint } from '../style.ts';
import { clipboardImage, notify, setTitle } from '../term.ts';
import { COMMANDS, findCommand, type AppExit, type CommandContext, type Overlay } from './commands.ts';
import { Composer, type ComposerKey, type SlashItem } from './composer.tsx';
import { Footer } from './footer.tsx';
import { LiveHeader, StillHeader, type HeaderInfo } from './header.tsx';
import { appendHistory, readHistory } from './history.ts';
import { ListPicker, when, type PickItem } from './pickers.tsx';
import { PendingPrompt } from './prompts.tsx';
import { buildRows, finalCount, type LocalRow, type Row } from './rows.ts';
import { clearScreen } from './screen.ts';
import { EFFORT_WORDS, MODE_CYCLE, MODE_WORDS } from './session.ts';
import { StatusLine } from './status.tsx';
import { RowView, shortPath, TextRow, ThinkingRow, ToolRow, todoLines, type TranscriptView, type ViewContext } from './views.tsx';

export interface AppProps {
  conn: Connected;
  paths: CliPaths;
  config: CliConfig;
  paint: Paint;
  folder: WorkspaceSummary;
  branch: string | null;
  models: ModelInfo[];
  model: ModelInfo | undefined;
  initialSessionId: string | null;
  initialPrompt: string | null;
  /** Start in this mode (`--mode`). */
  mode?: PermissionMode | undefined;
  /** A newer version is out (said under the tip). */
  notice?: Promise<string | null>;
  onExit(next: AppExit): void;
}

type StaticItem = { key: string; kind: 'header' } | { key: string; kind: 'row'; row: Row };

/** A session's live state from the shared live sessions, held while shown. */
function useLive(conn: Connected, sessionId: string | null): LiveSessionState {
  const store = useMemo(() => (sessionId ? conn.live.store(sessionId) : null), [conn, sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    conn.live.retain(sessionId);
    return () => conn.live.release(sessionId);
  }, [conn, sessionId]);
  const subscribe = useCallback((fn: () => void) => (store ? store.subscribe(fn) : () => undefined), [store]);
  return useSyncExternalStore(subscribe, () => (store ? store.getState() : initialLiveState));
}

const textOf = (parts: Part[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');

export function App(props: AppProps) {
  const { conn, paint, folder, paths } = props;
  const { exit, suspendTerminal } = useApp();
  const { columns } = useWindowSize();
  const [config, setConfig] = useState(props.config);
  const [sessionId, setSessionId] = useState<string | null>(props.initialSessionId);
  const state = useLive(conn, sessionId);
  const [local, setLocal] = useState<LocalRow[]>([]);
  const [epoch, setEpoch] = useState(0);
  const [started, setStarted] = useState(!!props.initialSessionId);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [view, setView] = useState<TranscriptView>(config.transcriptView);
  const [showTodos, setShowTodos] = useState(true);
  const [attachments, setAttachments] = useState<{ name: string; part: Part }[]>([]);
  const [inject, setInject] = useState<{ text: string } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [slash, setSlash] = useState<SlashItem[]>([]);
  const [models, setModels] = useState(props.models);
  const [chosen, setChosen] = useState<{ model?: ModelInfo | undefined; effort?: Effort | null; mode?: PermissionMode | undefined }>({ model: props.model, effort: (config.effort as Effort | undefined) ?? null, mode: props.mode ?? config.permissionMode });
  const [now, setNow] = useState(() => Date.now());
  const [link, setLink] = useState<'online' | 'connecting' | 'signed_out' | 'off' | undefined>(undefined);
  const [connected, setConnected] = useState(true);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [pip, setPip] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    void props.notice?.then((n) => n && setNotice(n));
  }, [props.notice]);
  const ctrlC = useRef(0);
  const escAt = useRef(0);
  const printed = useRef<string[]>([]);
  const ranSince = useRef<number | null>(null);
  const creating = useRef<Promise<string> | null>(null);
  const shellOutput = useRef<string[]>([]);

  const session = state.session;
  const modelRef = session?.model ?? chosen.model?.ref;
  const model = models.find((m) => m.ref === modelRef) ?? chosen.model;
  const mode: PermissionMode = session?.permissionMode ?? chosen.mode ?? 'auto';
  const effort = shownEffort(session?.effort ?? chosen.effort ?? null, model, 'code');
  const running = session?.status === 'running' || session?.status === 'waiting';
  const ctx: ViewContext = { paint, columns, root: folder.root, view };

  const print = useCallback((lines: string | string[]) => {
    const list = Array.isArray(lines) ? lines : [lines];
    setLocal((l) => [...l, { key: `local:${Date.now()}:${l.length}`, lines: list, at: Date.now() }]);
    setStarted(true);
  }, []);

  // Slash commands from the backend, history, and things that change under us.
  useEffect(() => {
    const load = () =>
      void conn.rpc
        .call('slash.list', { workspaceId: folder.id })
        .then((list) => setSlash(list.map((c) => ({ name: c.name, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) }))))
        .catch(() => undefined);
    load();
    void readHistory(paths.history, folder.root).then(setHistory);
    const offs = [
      conn.rpc.on('extensions.changed', load),
      conn.rpc.on('models.changed', () => void conn.rpc.call('models.list', {}).then(setModels).catch(() => undefined)),
      conn.transport.onStatus((up) => setConnected(up)),
    ];
    return () => offs.forEach((off) => off());
  }, [conn, folder, paths]);

  // Server mode: how the device link stands (the background service says).
  useEffect(() => {
    const service = conn.service;
    if (!service || conn.mode !== 'server') return;
    const off = service.onFrame((f) => f.t === 'status' && setLink(f.status.link));
    const ask = () => service.send({ t: 'status' });
    ask();
    const timer = setInterval(ask, 5000);
    return () => (off(), clearInterval(timer));
  }, [conn]);

  // A clock while a reply runs (elapsed time); notifications when one ends after a while.
  useEffect(() => {
    if (running) {
      ranSince.current ??= Date.now();
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }
    if (ranSince.current && Date.now() - ranSince.current > 8000 && config.notifications) notify('Atelier', state.pending ? 'Needs you' : `Done: ${session?.title || 'your session'}`);
    ranSince.current = null;
  }, [running, config.notifications, session?.title, state.pending]);

  useEffect(() => {
    if (state.pending && config.notifications) notify('Atelier', 'Waiting for your answer');
  }, [state.pending, config.notifications]);

  useEffect(() => {
    setTitle(`${running ? '◎ ' : ''}${session?.title || 'Atelier'} · ${basename(folder.root)}`);
  }, [running, session?.title, folder.root]);

  // A status line command, when set: run with the session described on stdin, every few seconds.
  useEffect(() => {
    const command = config.statusLine?.command;
    if (!command) return;
    const runIt = () => {
      const input = JSON.stringify({ session_id: sessionId, cwd: folder.root, model: { id: model?.ref, display_name: model?.displayName }, workspace: { current_dir: folder.root, project_dir: folder.root }, version: VERSION, permission_mode: mode });
      const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', command] : ['-c', command], { input, encoding: 'utf8', timeout: 2000 });
      setStatusLine(r.status === 0 ? (r.stdout.split('\n')[0] ?? '').slice(0, 300) : null);
    };
    const first = setTimeout(runIt, 0);
    const timer = setInterval(runIt, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      setStatusLine(null);
    };
  }, [config.statusLine?.command, sessionId, model?.ref, mode, folder.root, model?.displayName]);

  const rows = useMemo(() => buildRows(state, local), [state, local]);
  const done = finalCount(rows);
  const staticItems: StaticItem[] = useMemo(() => (started ? [{ key: 'header', kind: 'header' as const }, ...rows.slice(0, done).map((row) => ({ key: row.key, kind: 'row' as const, row }))] : []), [started, rows, done]);

  // What's printed can't change: when the rows before the printed edge differ (a rewind, a branch, compaction), print anew.
  useEffect(() => {
    const keys = staticItems.map((i) => i.key);
    const before = printed.current;
    const same = before.every((k, i) => keys[i] === k);
    if (!same) {
      clearScreen();
      setEpoch((e) => e + 1);
    }
    printed.current = keys;
  }, [staticItems]);

  const reprint = () => {
    clearScreen();
    printed.current = [];
    setEpoch((e) => e + 1);
  };

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId;
    creating.current ??= conn.rpc
      .call('sessions.create', {
        mode: 'code',
        workspaceId: folder.id,
        ...(chosen.model ? { model: chosen.model.ref } : {}),
        ...(chosen.effort ? { effort: chosen.effort } : {}),
        ...(chosen.mode ? { permissionMode: chosen.mode } : {}),
      })
      .then((s) => {
        setSessionId(s.id);
        setStarted(true);
        return s.id;
      })
      .finally(() => (creating.current = null));
    return creating.current;
  }, [sessionId, conn, folder.id, chosen]);

  const sendText = useCallback(
    async (text: string, how: 'send' | 'join' = 'send') => {
      setStarted(true);
      const id = await ensureSession();
      const extra = shellOutput.current.splice(0).map((t) => ({ type: 'context' as const, text: t }));
      const parts: Part[] = [...attachments.map((a) => a.part), ...extra, ...(text ? [{ type: 'text' as const, text }] : [])];
      setAttachments([]);
      if (running || how === 'join') await conn.rpc.call('chat.queue', { sessionId: id, parts, ...(how === 'join' ? { joinTurn: true } : {}) });
      else await conn.rpc.call('chat.send', { sessionId: id, parts });
    },
    [ensureSession, attachments, running, conn],
  );

  const quit = useCallback(
    (next: AppExit) => {
      props.onExit(next);
      exit();
    },
    [props, exit],
  );

  const commandCtx: CommandContext = {
    conn,
    paths,
    paint,
    columns,
    folder,
    config,
    models,
    sessionId,
    live: () => (sessionId ? state : null),
    model: () => model,
    ensureSession,
    print,
    send: (t) => sendText(t),
    newSession: () => {
      setSessionId(null);
      setLocal([]);
      setStarted(false);
      reprint();
    },
    switchTo: (id) => {
      setSessionId(id);
      setLocal([]);
      setStarted(true);
      reprint();
    },
    open: setOverlay,
    setMode: async (m) => {
      setChosen((c) => ({ ...c, mode: m }));
      if (sessionId) await conn.rpc.call('sessions.update', { id: sessionId, permissionMode: m });
    },
    setModel: async (m) => {
      setChosen((c) => ({ ...c, model: m }));
      if (sessionId) await conn.rpc.call('sessions.update', { id: sessionId, model: m.ref });
      print(paint.fg('muted', `Model: ${m.displayName}`));
    },
    setEffort: async (e) => {
      setChosen((c) => ({ ...c, effort: e }));
      if (sessionId) await conn.rpc.call('sessions.update', { id: sessionId, effort: e });
      print(paint.fg('muted', `Effort: ${EFFORT_WORDS[e]}`));
    },
    setView: (v) => {
      setView(v);
      reprint();
    },
    saveConfig: async (change) => setConfig(await updateConfig(paths.config, change)),
    exit: quit,
  };

  const run = async (text: string, how: 'send' | 'join') => {
    void appendHistory(paths.history, folder.root, text).then(() => setHistory((h) => [...h, text]));
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
    const command = m ? findCommand(m[1]!) : undefined;
    try {
      if (command) {
        if (command.name === 'pip') return setPip(Date.now());
        await command.run(commandCtx, m![2] ?? '');
      } else await sendText(text, how);
    } catch (e) {
      print(paint.fg('bad', describe(e)));
    }
  };

  const runShell = (command: string) => {
    void appendHistory(paths.history, folder.root, `!${command}`);
    const r = spawnSync(process.platform === 'win32' ? 'cmd' : process.env.SHELL || 'sh', process.platform === 'win32' ? ['/c', command] : ['-c', command], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\n+$/, '');
    const shown = output.split('\n').slice(-30);
    print([`${paint.fg('warn', '!')} ${paint.bold(command)}`, ...shown.map((l) => paint.fg('muted', `  ${l}`)), ...(r.status ? [paint.fg('bad', `  Exit code ${r.status}`)] : [])]);
    shellOutput.current.push(`<shell-command>${command}</shell-command>\n<shell-output exit="${r.status ?? 'none'}">\n${output.slice(-20_000)}\n</shell-output>\nThe person ran this command in the terminal; its output is above.`);
  };

  const attachFile = (path: string): boolean => {
    void (async () => {
      try {
        const bytes = await readFile(path);
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
        const ref = await conn.rpc.call('files.upload', { name: basename(path), mime, dataBase64: bytes.toString('base64') });
        setAttachments((a) => [...a, { name: basename(path), part: { type: 'image', mime, blob: ref.blob } as Part }]);
      } catch (e) {
        print(paint.fg('bad', `Couldn’t attach ${path}: ${describe(e)}`));
      }
    })();
    return true;
  };

  const editInEditor = async () => {
    const file = join(tmpdir(), `atelier-message-${process.pid}.md`);
    writeFileSync(file, '');
    const editor = config.editor || process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    await suspendTerminal(async () => void spawnSync(editor, [file], { stdio: 'inherit', shell: true }));
    const text = readFileSync(file, 'utf8').replace(/\n+$/, '');
    unlinkSync(file);
    if (text) setInject({ text });
  };

  const onKey = (key: ComposerKey, empty: boolean) => {
    switch (key) {
      case 'escape': {
        if (running && sessionId) {
          void conn.rpc.call('chat.stop', { sessionId }).catch(() => undefined);
          return;
        }
        const t = Date.now();
        if (empty && t - escAt.current < 600 && sessionId) setOverlay({ kind: 'rewind' });
        escAt.current = t;
        return;
      }
      case 'shift-tab': {
        const next = MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length]!;
        void commandCtx.setMode(next);
        return;
      }
      case 'ctrl-c': {
        const t = Date.now();
        if (t - ctrlC.current < 1500) return quit({ kind: 'quit', keepRunning: running });
        ctrlC.current = t;
        setHint(running ? 'Press Ctrl+C again to leave; the reply goes on in the background (atelier -c picks it up).' : 'Press Ctrl+C again to leave.');
        setTimeout(() => setHint(null), 1500);
        return;
      }
      case 'ctrl-d':
        return quit({ kind: 'quit', keepRunning: running });
      case 'ctrl-o': {
        const next: TranscriptView = view === 'normal' ? 'thinking' : view === 'thinking' ? 'verbose' : 'normal';
        commandCtx.setView(next);
        setHint(`Transcript: ${next === 'normal' ? 'steps in short' : next === 'thinking' ? 'with thinking' : 'every step in full'}`);
        setTimeout(() => setHint(null), 2000);
        return;
      }
      case 'ctrl-t':
        return setShowTodos((s) => !s);
      case 'ctrl-l':
        return reprint();
      case 'ctrl-g':
        return void editInEditor();
      case 'ctrl-v': {
        const file = join(tmpdir(), `atelier-paste-${Date.now()}.png`);
        void clipboardImage(file).then((ok) => (ok ? attachFile(file) : setHint('No image on the clipboard.')));
        return;
      }
      case 'ctrl-r':
        return setOverlay({ kind: 'resume' });
      case 'down-empty':
        if (state.tasks.length) void COMMANDS.find((c) => c.name === 'tasks')!.run(commandCtx, '');
        return;
      default:
        return;
    }
  };

  // Taking back a queued message: ↑ on an empty box edits the newest waiting one.
  const outbox = state.outbox;
  useInput(
    (_input, key) => {
      if (key.upArrow && outbox.length && sessionId) {
        const last = outbox.at(-1)!;
        void conn.rpc.call('chat.unqueue', { sessionId, id: last.id }).then((r) => setInject({ text: textOf(r.parts) }));
      }
    },
    { isActive: !!outbox.length && !state.pending && !overlay },
  );

  // The first prompt (`atelier "fix the tests"`) goes out once.
  const sentFirst = useRef(false);
  useEffect(() => {
    if (props.initialPrompt && !sentFirst.current) {
      sentFirst.current = true;
      void run(props.initialPrompt, 'send');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const headerInfo: HeaderInfo = {
    version: VERSION,
    model: `${model?.displayName ?? 'No model yet: /model'}${effort ? ` · ${EFFORT_WORDS[effort]}` : ''}`,
    where: conn.mode === 'server' ? `${conn.user.name} @ ${new URL(conn.serverUrl!).host}` : `${conn.user.name} · on this computer`,
    folder: shortPath(folder.root),
    branch: props.branch,
  };
  const status = liveStatus(state);
  const context = liveContext(state);
  const live = rows.slice(done);
  const respond = (answer: unknown) => {
    if (!sessionId || !state.pending) return;
    void conn.rpc.call('chat.respond', { sessionId, interactionId: state.pending.id, answer: answer as never }).catch((e: unknown) => print(paint.fg('bad', describe(e))));
  };

  const pickers = () => {
    if (!overlay) return null;
    const close = () => setOverlay(null);
    if (overlay.kind === 'model') {
      const items: PickItem<ModelInfo>[] = models
        .filter((m) => !m.hidden)
        .map((m) => ({ value: m, label: m.displayName, hint: `${m.ref}${m.personal ? ' · yours' : ''}${m.available === false ? ' · its computer is away' : ''}`, group: m.personal ? 'Your models' : m.providerId, current: m.ref === model?.ref }));
      return <ListPicker paint={paint} title="Model" items={items} onCancel={close} onPick={(m) => (close(), void commandCtx.setModel(m))} />;
    }
    if (overlay.kind === 'effort') {
      const items = effortChoices(model, 'code').map((e) => ({ value: e, label: EFFORT_WORDS[e], current: e === effort }));
      return <ListPicker paint={paint} title="Effort" items={items} onCancel={close} onPick={(e) => (close(), void commandCtx.setEffort(e))} empty="This model has no effort setting." />;
    }
    if (overlay.kind === 'mode') {
      const items = (Object.keys(MODE_WORDS) as PermissionMode[]).map((m) => ({ value: m, label: MODE_WORDS[m], current: m === mode, hint: { auto: 'a reviewing model checks what would ask', default: 'asks before edits and commands', acceptEdits: 'edits freely, commands ask', plan: 'reads and plans, changes nothing', bypassPermissions: 'asks nothing at all' }[m] }));
      return <ListPicker paint={paint} title="Mode" items={items} onCancel={close} onPick={(m) => (close(), void commandCtx.setMode(m))} />;
    }
    if (overlay.kind === 'resume') return <ResumePicker conn={conn} folder={folder} paint={paint} current={sessionId} onCancel={close} onPick={(id) => (close(), commandCtx.switchTo(id))} />;
    if (overlay.kind === 'rewind') {
      const points = state.messages.filter((m) => m.role === 'user' && m.kind === 'normal' && textOf(m.parts).trim());
      const items = points
        .map((m) => ({ value: m.id, label: textOf(m.parts).split('\n')[0]!.slice(0, 80), hint: when(m.createdAt) }))
        .reverse();
      return (
        <ListPicker
          paint={paint}
          title="Go back to before…"
          items={items}
          onCancel={close}
          empty="Nothing to go back to yet."
          onPick={(id) => {
            close();
            void conn.rpc
              .call('checkpoints.rewind', { sessionId: sessionId!, messageId: id, files: true, conversation: true })
              .then((r) => {
                conn.live.resetFromSnapshot(sessionId!, r.snapshot);
                const message = points.find((m) => m.id === id);
                if (message) setInject({ text: textOf(message.parts) });
                print(paint.fg('muted', r.restored.length ? `Went back; restored ${r.restored.length} ${r.restored.length === 1 ? 'file' : 'files'}.` : 'Went back.'));
              })
              .catch((e: unknown) => print(paint.fg('bad', describe(e))));
          }}
        />
      );
    }
    if (overlay.kind === 'config' || overlay.kind === 'theme') {
      const items: PickItem<() => Promise<void>>[] =
        overlay.kind === 'theme'
          ? (['auto', 'dark', 'light', 'plain'] as const).map((t) => ({ value: () => commandCtx.saveConfig((c) => ({ ...c, theme: t })), label: t[0]!.toUpperCase() + t.slice(1), current: config.theme === t, hint: 'from the next start' }))
          : [
              { value: () => commandCtx.saveConfig((c) => ({ ...c, notifications: !c.notifications })), label: `Notifications: ${config.notifications ? 'on' : 'off'}`, hint: 'when a reply ends or needs you' },
              { value: () => commandCtx.saveConfig((c) => ({ ...c, motion: !c.motion })), label: `Animation: ${config.motion ? 'on' : 'off'}`, hint: 'Pip and the banner' },
              { value: async () => setOverlay({ kind: 'theme' }), label: `Theme: ${config.theme}` },
              { value: () => commandCtx.saveConfig((c) => ({ ...c, transcriptView: view })), label: `Remember the transcript view (${view})`, hint: 'Ctrl+O changes it' },
              { value: () => commandCtx.saveConfig((c) => ({ ...c, permissionMode: mode })), label: `Start new sessions in ${MODE_WORDS[mode]}` },
              ...(model ? [{ value: () => commandCtx.saveConfig((c) => ({ ...c, model: model.ref })), label: `Start new sessions with ${model.displayName}` }] : []),
              ...(conn.mode === 'server' ? [{ value: () => commandCtx.saveConfig((c) => ({ ...c, keepAvailable: !c.keepAvailable })), label: `Keep this computer available: ${config.keepAvailable ? 'on' : 'off'}`, hint: 'the server can use this folder when no terminal is open' }] : []),
            ];
      return <ListPicker paint={paint} title={overlay.kind === 'theme' ? 'Theme' : 'Settings'} items={items} onCancel={close} onPick={(fn) => void fn().then(() => overlay.kind === 'theme' && close())} />;
    }
    return null;
  };

  const queued = outbox.length;
  const contextPercent = context ? Math.round((context.used / context.limit) * 100) : null;

  return (
    <>
      <Static key={epoch} items={staticItems}>
        {(item) => <Box key={item.key}>{item.kind === 'header' ? <StillHeader info={headerInfo} paint={paint} /> : <RowView row={item.row} ctx={ctx} />}</Box>}
      </Static>
      {!started && (
        <Box flexDirection="column">
          <LiveHeader info={headerInfo} paint={paint} motion={config.motion} />
          <Box marginBottom={1}>
            <Text>{paint.fg('muted', `Tip: ${TIPS[config.tipIndex % TIPS.length]}`)}</Text>
          </Box>
          {notice && (
            <Box marginBottom={1}>
              <Text>{paint.fg('accentSoft', notice)}</Text>
            </Box>
          )}
        </Box>
      )}
      {pip > 0 && <PipDance key={pip} paint={paint} />}
      {live.map((row) =>
        row.kind === 'text' ? (
          <TextRow key={row.key} text={row.text} ctx={ctx} />
        ) : row.kind === 'thinking' ? (
          <ThinkingRow key={row.key} text={row.text} seconds={null} ctx={ctx} live />
        ) : row.kind === 'tool' ? (
          <ToolRow key={row.key} call={row.call} result={row.result} ctx={ctx} running={running && !row.result} {...(state.toolOutput[row.call.id] !== undefined ? { output: state.toolOutput[row.call.id] } : {})} />
        ) : (
          <RowView key={row.key} row={row} ctx={ctx} />
        ),
      )}
      {status && !state.pending && <StatusLine status={status} paint={paint} now={now} />}
      {showTodos && running && state.todos.length > 0 && state.todos.some((t) => t.status !== 'completed') && (
        <Box flexDirection="column" marginBottom={1} marginLeft={2}>
          <Text>{todoLines(state.todos, paint).join('\n')}</Text>
        </Box>
      )}
      {outbox.map((m) => (
        <Text key={m.id}>{paint.fg('muted', `  ⏳ ${textOf(m.parts).split('\n')[0]!.slice(0, columns - 10)}`)}</Text>
      ))}
      {queued > 0 && <Text>{paint.fg('faint', '  waits for this reply · ↑ takes it back · ctrl+s sends into it')}</Text>}
      {state.status === 'error' && state.error && <Text>{paint.fg('bad', state.error)}</Text>}
      {state.pending ? (
        <PendingPrompt pending={state.pending} ctx={ctx} respond={respond} />
      ) : overlay ? (
        // eslint-disable-next-line react-hooks/refs -- the pickers' handlers use refs when picked, not while drawn.
        pickers()
      ) : (
        <Composer
          paint={paint}
          columns={columns}
          active={!state.pending && !overlay}
          placeholder={running ? 'Type to queue a message' : started ? 'Ask for a change, or /help' : `Ask about ${basename(folder.root)}, or /help`}
          commands={[...COMMANDS.filter((c) => !c.hidden).map((c) => ({ name: c.name, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) })), ...slash.filter((s) => !findCommand(s.name))]}
          findFiles={(query) => conn.rpc.call('workspaces.findFiles', { workspaceId: folder.id, query })}
          history={history}
          suggestion={running ? null : state.suggestion}
          attachments={attachments.map((a) => a.name)}
          onSubmit={(text, how) => void run(text, how)}
          onShell={runShell}
          onKey={onKey}
          onAttachPath={attachFile}
          inject={inject}
        />
      )}
      <Footer
        paint={paint}
        columns={columns}
        info={{
          mode,
          contextPercent,
          where: conn.mode === 'server' ? new URL(conn.serverUrl!).host : 'this computer',
          link: conn.mode === 'server' ? link : undefined,
          connected,
          model: model?.displayName ?? 'no model',
          effort: effort ? EFFORT_WORDS[effort] : null,
          queued,
          tasks: state.tasks.filter((t) => t.status === 'running').length,
          hint,
          statusLine,
        }}
      />
    </>
  );
}

/** `/pip`: Pip waves hello for a few seconds. */
function PipDance({ paint }: { paint: Paint }) {
  const { frame } = useAnimation({ interval: 140, isActive: paint.p.depth > 0 });
  if (frame >= PIP_HELLO.length * 2) return null;
  return (
    <Box marginBottom={1}>
      <Text>{`${drawPip(PIP_HELLO[frame % PIP_HELLO.length]!, paint.p.depth).join('\n')}`}</Text>
      <Text>{paint.fg('accentSoft', '  Hi! I’m Pip.')}</Text>
    </Box>
  );
}

function ResumePicker({ conn, folder, paint, current, onPick, onCancel }: { conn: Connected; folder: WorkspaceSummary; paint: Paint; current: string | null; onPick(id: string): void; onCancel(): void }) {
  const [items, setItems] = useState<PickItem<string>[] | null>(null);
  useEffect(() => {
    void Promise.all([conn.rpc.call('sessions.list', { mode: 'code', limit: 200 }), conn.rpc.call('workspaces.list', {})]).then(([list, folders]) => {
      const name = new Map(folders.map((f) => [f.id, f.root]));
      const here = list.filter((s) => s.workspaceId === folder.id);
      const elsewhere = list.filter((s) => s.workspaceId !== folder.id);
      setItems([
        ...here.map((s) => ({ value: s.id, label: s.title || 'Untitled', hint: `${when(s.updatedAt)}${s.status === 'running' ? ' · running' : ''}`, group: 'In this folder', current: s.id === current })),
        ...elsewhere.map((s) => ({ value: s.id, label: s.title || 'Untitled', hint: `${shortPath(name.get(s.workspaceId ?? '') ?? 'no folder')} · ${when(s.updatedAt)}`, group: 'Elsewhere', current: s.id === current })),
      ]);
    });
  }, [conn, folder.id, current]);
  if (!items) return <Text>{paint.fg('muted', 'Looking up your sessions…')}</Text>;
  return <ListPicker paint={paint} title="Resume a session" items={items} onPick={onPick} onCancel={onCancel} empty="No sessions yet." />;
}
