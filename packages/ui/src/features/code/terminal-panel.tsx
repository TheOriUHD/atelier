/**
 * One terminal (design/components.md › TerminalPanel): a shell on the workspace's machine in xterm.js, in the code
 * font on the sunken background. It follows its pane's size, closes when unmounted, and can be restarted after exit.
 * When the connection to the backend comes back after a drop, it attaches to the same shell again and replays what
 * it missed under a dim line.
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { keystrokes } from './terminal-keys.ts';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RotateCw } from 'lucide-react';
import colors from '../../../theme/colors.json';
import { Button } from '../../components/ui/index.ts';
import { getTransport } from '../../lib/platform.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useResolvedTheme } from '../../lib/theme.ts';

type Palette = (typeof colors)['light'];

function terminalTheme(c: Palette): ITheme {
  return {
    background: c['background-sunken'],
    foreground: c['text-primary'],
    cursor: c['text-primary'],
    cursorAccent: c['background-sunken'],
    selectionBackground: c.selection,
    red: c['danger-text'],
    green: c['success-text'],
    yellow: c['warning-text'],
    blue: c['interactive-text'],
    magenta: c.accent,
    cyan: c['interactive-text'],
    brightBlack: c['text-muted'],
    // xterm's own bright colors (#ffff55 yellow and friends) can't be read on the light background: the theme's
    // readable text colors stand in for them.
    brightRed: c['danger-text'],
    brightGreen: c['success-text'],
    brightYellow: c['warning-text'],
    brightBlue: c['interactive-text'],
    brightMagenta: c.accent,
    brightCyan: c['interactive-text'],
  };
}

/** Dim text, then back to normal. */
const dim = (text: string) => `\r\n\x1b[2m${text}\x1b[22m\r\n`;

export interface TerminalHandle {
  clear(): void;
  focus(): void;
  /** Types `command` into the shell and presses Enter (held until the shell is open). Several lines run in turn. */
  run(command: string): void;
}


export default function TerminalPanel({
  workspaceId,
  dir,
  label = 'Terminal',
  ref,
}: {
  workspaceId: string;
  /** The folder the shell starts in, relative to the workspace root; the root when absent. */
  dir?: string;
  label?: string;
  ref?: Ref<TerminalHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const theme = useResolvedTheme();
  // Bumped to start a new shell after the last one exited.
  const [run, setRun] = useState(0);
  const [ended, setEnded] = useState<string | null>(null);

  // Where typed input goes: the shell, or this queue until a shell is open (the handle is there before the effect runs).
  const waiting = useRef<string[]>([]);
  const send = useRef<(data: string) => void>((data) => void waiting.current.push(data));
  useImperativeHandle(ref, () => ({ clear: () => terminal.current?.clear(), focus: () => terminal.current?.focus(), run: (command) => send.current(keystrokes(command)) }), []);

  useEffect(() => {
    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--at-font-code').trim();
    // The terminal scale: 12px with lines about 2.35 cells tall (xterm multiplies the font's own line height, so
    // 1.07), which keeps ASCII art in proportion and fits the usual 100 or so columns in a pane.
    const term = new Terminal({
      fontFamily,
      fontSize: 12,
      lineHeight: 1.07,
      cursorBlink: true,
      theme: terminalTheme(colors[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light']),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    terminal.current = term;
    // Hidden (behind a maximized pane, or another terminal tab): keep the last size rather than collapsing to nothing.
    const refit = () => {
      if (host.current?.clientWidth) fit.fit();
    };
    refit();
    // xterm measures the font once: if the code font was still loading, measure again (and resize the shell) once it's in.
    void document.fonts?.ready.then(() => {
      if (!terminal.current) return;
      term.options.fontFamily = `${fontFamily}, monospace`;
      term.options.fontFamily = fontFamily;
      refit();
    });

    let id: string | null = null;
    let opened = false;
    let closed = false;
    send.current = (data) => {
      if (id) void rpc().call('terminals.write', { terminalId: id, data }).catch(() => {});
      else waiting.current.push(data);
    };
    /** Characters shown so far: where catching up after a reconnect starts. */
    let received = 0;
    const show = (data: string) => {
      received += data.length;
      term.write(data);
    };
    // Output can arrive before `terminals.open` answers; hold it until the id is known.
    const early: { terminalId: string; data: string }[] = [];
    const offData = rpc().on('terminals.data', (e) => {
      if (e.terminalId === id) show(e.data);
      else if (!opened) early.push(e);
    });
    const offExit = rpc().on('terminals.exit', (e) => {
      if (e.terminalId !== id) return;
      id = null;
      setEnded(e.code === null ? 'The shell exited.' : `The shell exited with code ${e.code}.`);
    });
    // The backend kept the shell while the connection was down: show it here again, with what went by meanwhile.
    const offReconnect = getTransport().onReconnect(() => {
      const terminalId = id;
      if (!terminalId) return;
      rpc()
        .call('terminals.attach', { terminalId, since: received })
        .then(({ data, truncated }) => {
          if (closed || id !== terminalId) return;
          term.write(dim(data || truncated ? '[shell reconnected — replaying buffered output]' : '[shell reconnected]'));
          show(data);
          void rpc().call('terminals.resize', { terminalId, cols: term.cols, rows: term.rows }).catch(() => {});
        })
        .catch(() => {
          if (closed || id !== terminalId) return;
          id = null;
          setEnded('The shell closed while the connection was down.');
        });
    });
    const input = term.onData((data) => {
      if (id) void rpc().call('terminals.write', { terminalId: id, data }).catch(() => {});
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (id) void rpc().call('terminals.resize', { terminalId: id, cols, rows }).catch(() => {});
    });
    const observer = new ResizeObserver(refit);
    observer.observe(host.current!);

    rpc()
      .call('terminals.open', { workspaceId, cols: term.cols, rows: term.rows, ...(dir ? { dir } : {}) })
      .then(({ terminalId }) => {
        if (closed) return void rpc().call('terminals.close', { terminalId }).catch(() => {});
        id = terminalId;
        opened = true;
        for (const e of early.splice(0)) if (e.terminalId === id) show(e.data);
        for (const data of waiting.current.splice(0)) void rpc().call('terminals.write', { terminalId, data }).catch(() => {});
      })
      .catch((e: unknown) => setEnded(describeError(e).message));

    return () => {
      closed = true;
      observer.disconnect();
      offData();
      offExit();
      offReconnect();
      input.dispose();
      resize.dispose();
      if (id) void rpc().call('terminals.close', { terminalId: id }).catch(() => {});
      term.dispose();
      terminal.current = null;
    };
  }, [workspaceId, dir, run]);

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = terminalTheme(colors[theme]);
  }, [theme]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-sunken">
      {/* xterm sizes itself to its parent's box, so the padding sits outside it. */}
      <div className="min-h-0 flex-1 p-3">
        <div ref={host} aria-label={label} role="group" className="size-full" />
      </div>
      {ended && (
        <div className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-2 text-body text-fg-muted">
          <span className="min-w-0 flex-1">{ended}</span>
          <Button
            size="sm"
            leadingIcon={RotateCw}
            onClick={() => {
              setEnded(null);
              setRun((n) => n + 1);
            }}
          >
            Restart
          </Button>
        </div>
      )}
    </div>
  );
}
