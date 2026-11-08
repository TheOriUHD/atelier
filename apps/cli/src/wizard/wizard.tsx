/**
 * `atelier setup` (ARCHITECTURE §25): the first-run wizard, full screen, in as few screens as it can:
 *   1. the wordmark and where Atelier runs: a server found on the network or used before, another one typed in, or only
 *      this computer;
 *   2. signing in: the browser code (servers from 0.6.0), else username and password on one screen, or an invite; a
 *      new server's first admin with its setup token;
 *   3. what this computer lends the server (standalone: your name, then providers);
 *   4. the model and the mode;
 *   5. a summary, with Shift+Enter set up where the terminal needs it.
 * Each part can be run again on its own (`atelier login`, `atelier connect`).
 */
import { hostname, networkInterfaces } from 'node:os';
import { Box, Text, render, useAnimation, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { contract, createRpcClient, DEFAULT_BASE_URLS, PROVIDER_LABELS, type AppContract, type AppInfo, type ModelInfo, type PermissionMode, type ProviderType, type RpcClient, type TerminalSignInStart, type UserSummary } from '@atelier/protocol';
import { wsTransport, type ReconnectingTransport } from '@atelier/client';
import { applyLending, changeLending, diagnose, healthCheck, resolveServer, scanNetwork, type FoundServer } from '@atelier/core/device';
import { knownServers, localNetworkBlocked, networkProgram, openLocalNetworkSettings, terminalApp, type KnownServer } from '../connection/known.ts';
import { bigBanner, TAGLINE } from '../art/banner.ts';
import { drawPip, PIP_IDLE } from '../art/mascot.ts';
import { qrLines } from '../art/qr.ts';
import { DAB_FRAMES } from '../art/words.ts';
import { updateConfig, writePrivate, type CliConfig } from '../config.ts';
import { describe } from '../connection/connect.ts';
import { cliDevice } from '../daemon/daemon.ts';
import { connectService, serviceTransport } from '../daemon/client.ts';
import { credentialStore, tokenName } from '../keychain.ts';
import type { CliPaths } from '../paths.ts';
import { USER_AGENT, VERSION } from '../runtime.ts';
import { colorDepth, Paint, palette, type Shade } from '../style.ts';
import { openUrl } from '../term.ts';
import { Choices, FilterList, Form, TextLine, type Choice, type ListItem } from '../tui/inputs.tsx';
import { MODE_WORDS } from '../tui/session.ts';
import { shortPath } from '../tui/views.tsx';
import { setupTerminal, terminalName } from '../commands/terminal-setup.ts';
import { Frame, LOCAL_CRUMBS, SERVER_CRUMBS } from './frame.tsx';

export type SetupStart = 'all' | 'login' | 'connect';

type Step =
  | { s: 'start' }
  | { s: 'address' }
  | { s: 'checking'; typed: string }
  | { s: 'blocked'; typed: string }
  | { s: 'first-admin'; serverUrl: string; error?: string }
  | { s: 'browser'; start: TerminalSignInStart | null; opened: boolean }
  | { s: 'password'; error?: string }
  | { s: 'invite'; error?: string }
  | { s: 'device' }
  | { s: 'local-account'; error?: string }
  | { s: 'providers'; note?: string }
  | { s: 'provider-key'; type: ProviderType; error?: string; busy?: boolean }
  | { s: 'provider-code'; kind: 'chatgpt' | 'copilot'; url: string; code?: string; opened: boolean }
  | { s: 'model'; models: ModelInfo[] }
  | { s: 'done'; note?: string };

/** Which breadcrumb each step is (the last one's length: all done). */
const SERVER_AT: Partial<Record<Step['s'], number>> = { address: 0, checking: 0, blocked: 0, 'first-admin': 1, browser: 1, password: 1, invite: 1, device: 2, model: 3, done: 4 };
const LOCAL_AT: Partial<Record<Step['s'], number>> = { 'local-account': 1, providers: 2, 'provider-key': 2, 'provider-code': 2, model: 3, done: 4 };

const MODE_HINTS: Partial<Record<PermissionMode, string>> = {
  auto: 'A reviewing model lets through what you asked for and asks you about the rest.',
  default: 'Asks you before every edit and command.',
  acceptEdits: 'Edits files freely; commands still ask.',
};
const MODES = Object.keys(MODE_HINTS) as PermissionMode[];

interface Props {
  paths: CliPaths;
  config: CliConfig;
  start: SetupStart;
  shade: Shade;
  /** A session starts after it (the first start, or /setup in one), or the command ends. */
  afterwards: 'session' | 'exit';
  onDone(config: CliConfig | null): void;
}

const platformName = () => (process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux');
const hostOf = (url: string) => URL.parse(url)?.host ?? url;

/** The wordmark painted in from the left once, and the tagline. */
function Banner({ paint, columns, motion }: { paint: Paint; columns: number; motion: boolean }) {
  const [painted, setPainted] = useState(!motion || paint.p.depth === 0);
  const { frame } = useAnimation({ interval: 50, isActive: !painted });
  if (!painted && frame >= 30) setPainted(true);
  const reveal = painted ? 1 : Math.min(1, frame / 30);
  return (
    <Box flexDirection="column" alignItems="center" marginTop={1}>
      <Text>{bigBanner(paint, columns, reveal).join('\n')}</Text>
      <Text>{paint.fg('secondary', TAGLINE)}</Text>
    </Box>
  );
}

/** The code to approve in the browser, with its link and QR code. Enter opens the page; p and i sign in another way. */
function BrowserSignIn({ paint, start, opened, rows, onOpen, onPassword, onInvite, onBack }: { paint: Paint; start: TerminalSignInStart | null; opened: boolean; rows: number; onOpen(): void; onPassword(): void; onInvite(): void; onBack(): void }) {
  useInput((input, key) => {
    if (key.return && start) return onOpen();
    if (key.escape) return onBack();
    if (input === 'p') return onPassword();
    if (input === 'i') return onInvite();
  });
  if (!start) return <Text>{paint.fg('muted', 'Asking the server for a code…')}</Text>;
  const big = [...start.code].map((ch) => (ch === '-' ? ' ' : ch)).join(' ');
  // The QR code only where the window is tall enough for it and the frame around it.
  const qr = qrLines(start.verifyUrlComplete, paint.p.shade);
  const roomForQr = rows >= qr.length + 14;
  return (
    <Box flexDirection="row" gap={3}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
        <Text>{opened ? 'Your browser has the page open. Approve the terminal there if it shows this code:' : 'Open this page where you are signed in, and approve the terminal if it shows this code:'}</Text>
        <Box marginY={1} borderStyle="round" borderColor={paint.p.depth ? paint.p.accent : undefined} paddingX={2} alignSelf="flex-start">
          <Text>{paint.bold(paint.fg('accent', big))}</Text>
        </Box>
        <Text wrap="truncate-middle">{paint.fg('info', start.verifyUrlComplete)}</Text>
        <Text>{paint.fg('muted', roomForQr ? 'Or scan the code with your phone. It works for 10 minutes.' : 'The code works for 10 minutes. A taller window shows a QR code for your phone.')}</Text>
        <Box marginTop={1}>
          <Text>{`${paint.fg('accent', '◎')} ${paint.fg('secondary', 'Waiting for you to approve it…')}`}</Text>
        </Box>
      </Box>
      {roomForQr && (
        <Box flexShrink={0}>
          <Text>{qr.join('\n')}</Text>
        </Box>
      )}
    </Box>
  );
}

/** The model list (typing filters it) and the mode beside it (←/→). */
function ModelStep({ paint, models, local, model, mode, rows, onDone, onBack }: { paint: Paint; models: ModelInfo[]; local: boolean; model: string | undefined; mode: PermissionMode; rows: number; onDone(model: string | undefined, mode: PermissionMode): void; onBack(): void }) {
  const [chosenMode, setChosenMode] = useState<PermissionMode>(MODES.includes(mode) ? mode : 'auto');
  useInput((_input, key) => {
    const i = MODES.indexOf(chosenMode);
    if (key.leftArrow) setChosenMode(MODES[(i - 1 + MODES.length) % MODES.length]!);
    if (key.rightArrow) setChosenMode(MODES[(i + 1) % MODES.length]!);
  });
  const items: ListItem<string>[] = [
    { value: '', label: local ? 'The first one that works' : 'My account’s default', aside: local ? 'Atelier picks' : 'the one the browser and the app start with' },
    ...models.map((m) => ({ value: m.ref, label: m.displayName, group: m.personal ? 'Your models' : m.providerId, ...(m.available === false ? { aside: 'its computer is away' } : {}) })),
  ];
  const modes = MODES.map((m) => (m === chosenMode ? paint.bold(paint.fg('accent', `‹ ${MODE_WORDS[m]} ›`)) : paint.fg('muted', `  ${MODE_WORDS[m]}  `))).join(' ');
  return (
    <Box flexDirection="column">
      {models.length === 0 && <Text>{paint.fg('warn', local ? 'No models yet: go back and add a provider, or add one later with atelier setup.' : 'This server has no models for you yet. An admin adds providers in Settings › Admin › Providers.')}</Text>}
      <FilterList paint={paint} items={items} rows={rows} initial={model ?? ''} onPick={(v) => onDone(v || undefined, chosenMode)} onCancel={onBack} />
      <Box marginTop={1} flexDirection="column">
        <Text>{`${paint.bold('Mode')}  ${modes}`}</Text>
        <Box paddingLeft={6}>
          <Text>{paint.fg('muted', `${MODE_HINTS[chosenMode]} Shift+Tab switches it in a session.`)}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function Wizard({ paths, config: initial, start, shade, afterwards, onDone }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [config, setConfig] = useState(initial);
  const depth = initial.theme === 'plain' ? 0 : colorDepth();
  const paint = new Paint(palette(initial.theme === 'light' ? 'light' : initial.theme === 'dark' ? 'dark' : shade, depth));
  const [step, setStep] = useState<Step>(start === 'login' && initial.connection?.mode === 'server' ? { s: 'checking', typed: initial.connection.serverUrl } : { s: 'start' });
  const [found, setFound] = useState<FoundServer[]>([]);
  const [scanning, setScanning] = useState(true);
  const [known, setKnown] = useState<KnownServer[]>([]);
  /** macOS refuses this terminal the local network (null: not known yet). */
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const [server, setServer] = useState<{ url: string; info: AppInfo | null } | null>(null);
  const [user, setUser] = useState<UserSummary | null>(null);
  const [mode, setMode] = useState<'server' | 'local' | null>(initial.connection?.mode ?? null);
  const rpcRef = useRef<{ rpc: RpcClient<AppContract>; transport: ReconnectingTransport } | null>(null);
  /** The same client for what is drawn (a ref isn't read while rendering). */
  const [client, setClient] = useState<RpcClient<AppContract> | null>(null);
  const [lend, setLend] = useState({ scratch: true, home: true });
  const [deviceName] = useState(`${hostname().replace(/\.local$/, '')} · terminal`);
  const [chosenModel, setChosenModel] = useState<{ ref: string; name: string } | undefined>(initial.model ? { ref: initial.model, name: initial.model } : undefined);
  const [note, setNote] = useState<string | null>(null);
  /** The username tried last: kept when a password was wrong. */
  const [username, setUsername] = useState(initial.connection?.mode === 'server' ? (initial.connection.username ?? '') : '');
  const { frame } = useAnimation({ interval: 140, isActive: depth > 0 && initial.motion });

  const finish = (result: CliConfig | null) => {
    rpcRef.current?.transport.close();
    onDone(result);
    exit();
  };
  const save = async (change: (c: CliConfig) => CliConfig) => setConfig(await updateConfig(paths.config, change));

  // Look for servers on the network while the person reads the first screen.
  // Scanning starts as true; a scan again (after the person allowed the network) sets it first.
  const scan = () =>
    void scanNetwork({ interfaces: networkInterfaces(), fetch, onFound: (s) => setFound((list) => (list.some((x) => x.url === s.url) ? list : [...list, s])) })
      .then((all) => (all.length ? setBlocked(false) : localNetworkBlocked().then(setBlocked)))
      .finally(() => setScanning(false));
  const rescan = () => {
    setScanning(true);
    scan();
  };
  useEffect(() => {
    void knownServers(initial).then(setKnown);
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // macOS turns connections down while its question about the local network is open, and asks only a program that is
  // still running (Apple's TN3179): so keep checking every 2 seconds, and scan again once the person allowed it.
  useEffect(() => {
    if (!blocked) return;
    let stop = false;
    void (async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 2000));
        if (stop || (await localNetworkBlocked())) continue;
        if (stop) return;
        setBlocked(false);
        return rescan();
      }
    })();
    return () => void (stop = true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') finish(null);
  });

  const rpc = () => rpcRef.current!.rpc;
  /** A server from before 0.6.0 knows no `cli` client kind: the terminal signs in there as the desktop app does. */
  const serverKind = (): 'cli' | 'desktop' => (server?.info?.terminalSignIn ? 'cli' : 'desktop');

  /** A WebSocket to the server for the wizard's calls (anonymous until it signs in over it). */
  const openServer = (url: string) => {
    rpcRef.current?.transport.close();
    const transport = wsTransport({ serverUrl: url, headers: () => ({ 'User-Agent': USER_AGENT }) });
    rpcRef.current = { rpc: createRpcClient(contract, transport), transport };
    setClient(rpcRef.current.rpc);
  };

  const signedIn = async (result: { token: string; user: UserSummary }) => {
    const url = server!.url;
    const store = await credentialStore(paths.credentials);
    await store.set(tokenName(url), result.token);
    await save((c) => ({ ...c, connection: { mode: 'server', serverUrl: url, username: result.user.username } }));
    setUser(result.user);
    // A running background service for this server takes the new token.
    void connectService(paths, { mode: 'server', serverUrl: url }, { start: false })
      .then((link) => (link.send({ t: 'token' }), link.close()))
      .catch(() => undefined);
    if (start === 'login') {
      const device = await cliDevice(paths);
      await rpc().call('devices.register', device).catch(() => undefined);
      return finish({ ...config, connection: { mode: 'server', serverUrl: url, username: result.user.username } });
    }
    setStep({ s: 'device' });
  };

  /** Signing in: the browser code where the server has it, else the password. */
  const startBrowser = async () => {
    setStep({ s: 'browser', start: null, opened: false });
    try {
      const startInfo = await rpc().call('auth.terminalStart', { deviceName, platform: platformName() });
      setStep({ s: 'browser', start: startInfo, opened: false });
    } catch (e) {
      setStep({ s: 'password', error: describe(e) });
    }
  };
  const signInStep = () => (server?.info?.terminalSignIn ? void startBrowser() : setStep({ s: 'password' }));

  const checkServer = async (typed: string) => {
    try {
      const resolved = await resolveServer(typed, healthCheck());
      const url = resolved.serverUrl;
      openServer(url);
      const info = await rpc().call('app.info', {});
      setServer({ url, info });
      const status = await rpc().call('auth.status', {});
      setMode('server');
      if (status.setupRequired) return setStep({ s: 'first-admin', serverUrl: url });
      if (info.terminalSignIn) return void startBrowser();
      setStep({ s: 'password' });
    } catch (e) {
      // Why it failed, in words: no such name, refused, a certificate, or (macOS) the terminal kept off the local network.
      const guess = /^[a-z][a-z\d+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
      const problem = await diagnose(guess).catch(() => null);
      if (problem?.localNetwork) return setStep({ s: 'blocked', typed });
      setStep({ s: 'address' });
      setNote(`Couldn’t reach Atelier at ${typed}: ${problem && problem.code !== 'WEBSOCKET' && !problem.code.startsWith('HTTP_2') ? problem.message : describe(e)}`);
    }
  };
  useEffect(() => {
    if (step.s === 'checking') void checkServer(step.typed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.s === 'checking' ? step.typed : null]);
  // While macOS asks (or until the person switches it on), try the server every 2 seconds and go on once it answers.
  useEffect(() => {
    if (step.s !== 'blocked') return;
    const typed = step.typed;
    let stop = false;
    void (async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 2000));
        if (stop) return;
        const answered = await resolveServer(typed, healthCheck()).then(
          () => true,
          () => false,
        );
        if (!answered || stop) continue;
        setBlocked(false);
        rescan();
        return setStep({ s: 'checking', typed });
      }
    })();
    return () => void (stop = true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.s === 'blocked' ? step.typed : null]);

  // Browser sign-in: poll until the person approves it in the browser.
  const pollToken = step.s === 'browser' ? step.start?.pollToken : null;
  useEffect(() => {
    if (step.s !== 'browser' || !step.start) return;
    const { interval, pollToken: token } = step.start;
    let stop = false;
    const poll = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, interval * 1000));
        if (stop) return;
        try {
          const r = await rpc().call('auth.terminalPoll', { pollToken: token });
          if (r.state === 'approved') return void (await signedIn(r));
          if (r.state === 'denied') return setStep({ s: 'password', error: 'The sign-in was turned down in the browser. Sign in with your password, or press Esc and try again.' });
          if (r.state === 'expired') return void startBrowser();
        } catch {
          // A dropped connection: the next poll goes through the reconnected socket.
        }
      }
    };
    void poll();
    return () => void (stop = true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollToken]);

  const toLocal = async () => {
    setMode('local');
    await save((c) => ({ ...c, connection: { mode: 'local' } }));
    const link = await connectService(paths, { mode: 'local' });
    const transport = serviceTransport(paths, link, { mode: 'local' });
    rpcRef.current = { rpc: createRpcClient(contract, transport), transport };
    setClient(rpcRef.current.rpc);
    const status = await rpc().call('auth.status', {});
    if (status.setupRequired) return setStep({ s: 'local-account' });
    if (!status.user) setUser((await rpc().call('auth.localSignIn', { clientKind: 'cli' })).user);
    else setUser(status.user);
    setStep({ s: 'providers' });
  };

  const toModel = async () => {
    const models = await rpc()
      .call('models.list', {})
      .catch(() => [] as ModelInfo[]);
    setStep({ s: 'model', models: models.filter((m) => !m.hidden) });
  };

  const lendNow = async () => {
    const device = await cliDevice(paths);
    if (device.name !== deviceName) await writePrivate(paths.device, `${JSON.stringify({ ...device, name: deviceName }, null, 2)}\n`);
    await changeLending(paths.lending, server!.url, (current) => applyLending(applyLending(current, { kind: 'scratch', allowed: lend.scratch }), { kind: 'home', allowed: lend.home }));
    await rpc().call('devices.register', { ...device, name: deviceName }).catch(() => undefined);
    await toModel();
  };

  // The first screen's servers: the one the desktop app uses and the one used before, then those found on the network
  // (by the address they say people use, when they say one).
  const servers: Choice<string>[] = [
    ...known.map((k) => ({ value: k.url, label: hostOf(k.url), aside: k.why })),
    ...found
      .filter((f) => !known.some((k) => k.url === (f.publicUrl ?? f.url)))
      .map((f) => ({ value: f.publicUrl ?? f.url, label: f.publicUrl ? hostOf(f.publicUrl) : f.host, aside: `Atelier ${f.version ?? ''} on your network${f.publicUrl ? `, at ${f.host}` : ''}` })),
  ];
  const crumbs = mode === 'local' ? LOCAL_CRUMBS : SERVER_CRUMBS;
  const at = (mode === 'local' ? LOCAL_AT : SERVER_AT)[step.s];
  const spinner = paint.fg('accent', DAB_FRAMES[frame % DAB_FRAMES.length]!);
  const showPip = columns >= 96 && step.s !== 'browser';
  const pip = showPip ? drawPip(initial.motion && depth ? PIP_IDLE[frame % PIP_IDLE.length]! : 'base', depth) : null;
  const keys = (extra = 'enter continue') => `${extra} · esc back · ctrl+c quit`;

  const body = ((): { title: string; keys: string; content: React.ReactNode } => {
    switch (step.s) {
      case 'start': {
        const status = scanning
          ? `${spinner} ${paint.fg('muted', 'Looking for Atelier servers on your network…')}`
          : blocked
            ? paint.fg('warn', `macOS hasn’t let “${networkProgram()}” reach your local network yet: choose Allow when it asks, or switch it on under System Settings › Privacy & Security › Local Network.`)
            : found.length
              ? paint.fg('muted', `Found ${found.length === 1 ? 'one server' : `${found.length} servers`} on your network.`)
              : paint.fg('muted', 'No server found on your network; one elsewhere works too.');
        return {
          title: 'Where should Atelier run?',
          keys: '↑/↓ choose · enter continue · ctrl+c quit',
          content: (
            <Box flexDirection="column">
              <Text>{paint.fg('secondary', 'With an Atelier server, models and keys are set up once and your sessions follow you to the browser and the desktop app. This computer lends the folders you open.')}</Text>
              <Box marginY={1}>
                <Choices
                  paint={paint}
                  choices={[
                    ...servers,
                    { value: 'other', label: servers.length ? 'Another server…' : 'An Atelier server…', aside: 'type its address' },
                    { value: 'local', label: 'Only this computer', aside: 'your own models and keys, kept here' },
                  ]}
                  onPick={(v) => (v === 'other' ? (setNote(null), setStep({ s: 'address' })) : v === 'local' ? void toLocal().catch((e: unknown) => setNote(describe(e))) : (setNote(null), setStep({ s: 'checking', typed: v })))}
                />
              </Box>
              <Text>{status}</Text>
            </Box>
          ),
        };
      }
      case 'address':
        return {
          title: 'Which server?',
          keys: keys(),
          content: (
            <Box flexDirection="column">
              {note && <Text>{paint.fg('bad', note)}</Text>}
              <Text>The address you open it at in the browser:</Text>
              <TextLine paint={paint} placeholder="atelier.example.com" initial={initial.connection?.mode === 'server' ? initial.connection.serverUrl : ''} onSubmit={(v) => v.trim() && (setNote(null), setStep({ s: 'checking', typed: v.trim() }))} onCancel={() => setStep({ s: 'start' })} />
              <Text>{paint.fg('muted', 'https:// is tried first; http:// only for addresses on your own network.')}</Text>
            </Box>
          ),
        };
      case 'checking':
        return { title: 'Which server?', keys: 'ctrl+c quit', content: <Text>{`${spinner} ${paint.fg('muted', `Checking ${hostOf(step.typed)}…`)}`}</Text> };
      case 'blocked': {
        const program = networkProgram();
        const host = hostOf(/^[a-z][a-z\d+.-]*:\/\//i.test(step.typed) ? step.typed : `https://${step.typed}`);
        return {
          title: `Allow “${program}” on your local network`,
          keys: keys('enter pick'),
          content: (
            <Box flexDirection="column">
              <Text>{`${host} is on your local network, and macOS asks each program once before it reaches devices there. Atelier runs as “${program}”, which asks for itself: what ${terminalApp()} may do doesn’t count for it.`}</Text>
              <Box marginY={1} flexDirection="column">
                <Text>{`macOS asks: Allow “${program}” to find devices on local networks? Choose ${paint.bold('Allow')}, and this goes on by itself.`}</Text>
                <Text>{`No question, or you chose Don’t Allow? Switch ${paint.bold(`“${program}”`)} on under ${paint.bold('System Settings › Privacy & Security › Local Network')}.`}</Text>
              </Box>
              <Text>{`${spinner} ${paint.fg('muted', `Trying ${host} again every 2 seconds…`)}`}</Text>
              <Box marginTop={1}>
                <Choices
                  paint={paint}
                  choices={[
                    { value: 'open', label: 'Open the Local Network settings' },
                    { value: 'other', label: 'Another address' },
                  ]}
                  onPick={(v) => (v === 'open' ? openLocalNetworkSettings() : setStep({ s: 'address' }))}
                  onCancel={() => setStep({ s: 'start' })}
                />
              </Box>
            </Box>
          ),
        };
      }
      case 'first-admin':
        return {
          title: `${hostOf(step.serverUrl)} isn’t set up yet`,
          keys: keys('tab next field · enter continue'),
          content: (
            <Box flexDirection="column">
              <Text>{paint.fg('muted', 'You make its first account here, the admin. The setup token is printed in the server’s log (docker compose logs atelier).')}</Text>
              {step.error && <Text>{paint.fg('bad', step.error)}</Text>}
              <Box marginTop={1}>
                <Form
                  paint={paint}
                  fields={[
                    { name: 'token', label: 'Setup token', mask: true },
                    { name: 'name', label: 'Your name' },
                    { name: 'username', label: 'Username', placeholder: 'lowercase, like ada' },
                    { name: 'password', label: 'Password', mask: true, placeholder: 'at least 10 characters' },
                  ]}
                  onCancel={() => setStep({ s: 'start' })}
                  onSubmit={(v) =>
                    void rpc()
                      .call('auth.setup', { setupToken: v.token!, name: v.name!, username: v.username!.toLowerCase(), password: v.password!, clientKind: serverKind() })
                      .then(signedIn)
                      .catch((e: unknown) => setStep({ s: 'first-admin', serverUrl: step.serverUrl, error: describe(e) }))
                  }
                />
              </Box>
            </Box>
          ),
        };
      case 'browser':
        return {
          title: `Sign in to ${server ? hostOf(server.url) : 'the server'}`,
          keys: 'enter open the page · p password instead · i invite code · esc back',
          content: (
            <BrowserSignIn
              paint={paint}
              start={step.start}
              opened={step.opened}
              rows={rows}
              onOpen={() => step.start && setStep({ ...step, opened: openUrl(step.start.verifyUrlComplete) })}
              onPassword={() => setStep({ s: 'password' })}
              onInvite={() => setStep({ s: 'invite' })}
              onBack={() => setStep({ s: 'start' })}
            />
          ),
        };
      case 'password': {
        return {
          title: `Sign in to ${server ? hostOf(server.url) : 'the server'}`,
          keys: keys('tab next field · enter sign in'),
          content: (
            <Box flexDirection="column">
              {step.error && <Text>{paint.fg('bad', step.error)}</Text>}
              {!server?.info?.terminalSignIn && <Text>{paint.fg('muted', `This server (Atelier ${server?.info?.version ?? 'older'}) signs terminals in with a password. From ${VERSION} on, it can also approve them in the browser.`)}</Text>}
              <Box marginTop={1}>
                <Form
                  key={step.error ?? 'form'}
                  paint={paint}
                  fields={[
                    { name: 'username', label: 'Username', initial: username },
                    { name: 'password', label: 'Password', mask: true },
                  ]}
                  extra={{ label: 'I have an invite code instead', onPick: () => setStep({ s: 'invite' }) }}
                  onCancel={() => (server?.info?.terminalSignIn ? void startBrowser() : setStep({ s: 'start' }))}
                  onSubmit={(v) => {
                    setUsername(v.username!);
                    void rpc()
                      .call('auth.login', { username: v.username!.toLowerCase(), password: v.password!, clientKind: serverKind() })
                      .then(signedIn)
                      .catch((e: unknown) => setStep({ s: 'password', error: describe(e) }));
                  }}
                />
              </Box>
            </Box>
          ),
        };
      }
      case 'invite':
        return {
          title: 'Make your account',
          keys: keys('tab next field · enter continue'),
          content: (
            <Box flexDirection="column">
              {step.error && <Text>{paint.fg('bad', step.error)}</Text>}
              <Form
                key={step.error ?? 'form'}
                paint={paint}
                fields={[
                  { name: 'invite', label: 'Invite code', placeholder: 'XXXX-XXXX-XXXX-XXXX' },
                  { name: 'name', label: 'Your name' },
                  { name: 'username', label: 'Username', placeholder: 'lowercase, like ada' },
                  { name: 'password', label: 'Password', mask: true, placeholder: 'at least 10 characters' },
                ]}
                onCancel={() => signInStep()}
                onSubmit={(v) =>
                  void rpc()
                    .call('auth.acceptInvite', { invite: v.invite!, name: v.name!, username: v.username!.toLowerCase(), password: v.password!, clientKind: serverKind() })
                    .then(signedIn)
                    .catch((e: unknown) => setStep({ s: 'invite', error: describe(e) }))
                }
              />
            </Box>
          ),
        };
      case 'device':
        return {
          title: 'What this computer lends the server',
          keys: 'space switch · enter continue · esc back',
          content: (
            <Box flexDirection="column">
              <Text>{`Signed in as ${paint.bold(user?.name ?? '')}.`}</Text>
              <Text>{`The server lists this computer as ${paint.bold(deviceName)}.`}</Text>
              <Box marginY={1}>
                <Choices
                  paint={paint}
                  numbered={false}
                  initial={1}
                  choices={[
                    { value: 'folders', label: `${paint.fg('good', '[✓]')} Folders you open in the terminal`, aside: 'asked once for each', disabled: true },
                    { value: 'scratch', label: `${lend.scratch ? paint.fg('good', '[✓]') : '[ ]'} New empty folders`, aside: 'for sessions started without one' },
                    { value: 'home', label: `${lend.home ? paint.fg('good', '[✓]') : '[ ]'} Your skills and instructions`, aside: '~/.claude and ~/.atelier' },
                  ]}
                  onToggle={(v) => (v === 'scratch' || v === 'home') && setLend({ ...lend, [v]: !lend[v] })}
                  onPick={() => void lendNow().catch((e: unknown) => setNote(describe(e)))}
                  onCancel={() => signInStep()}
                />
              </Box>
              <Text>{paint.fg('warn', 'Folders you open let your server’s sessions run commands as you on this computer. Only connect to a server you trust like that.')}</Text>
            </Box>
          ),
        };
      case 'local-account':
        return {
          title: 'What should Atelier call you?',
          keys: keys(),
          content: (
            <Box flexDirection="column">
              {step.error && <Text>{paint.fg('bad', step.error)}</Text>}
              <TextLine
                paint={paint}
                placeholder="Your name"
                onSubmit={(name) =>
                  name.trim() &&
                  void rpc()
                    .call('auth.setupLocal', { name: name.trim(), clientKind: 'cli' })
                    .then((r) => (setUser(r.user), setStep({ s: 'providers' })))
                    .catch((e: unknown) => setStep({ s: 'local-account', error: describe(e) }))
                }
                onCancel={() => setStep({ s: 'start' })}
              />
              <Text>{paint.fg('muted', 'Everything stays on this computer, in ~/.atelier/cli.')}</Text>
            </Box>
          ),
        };
      case 'providers':
        return { title: 'Which models?', keys: keys(), content: <Providers paint={paint} rpc={client!} note={step.note} onAdd={(type) => setStep({ s: 'provider-key', type })} onCode={(sign) => setStep({ s: 'provider-code', ...sign })} onNext={() => void toModel()} onBack={() => setStep({ s: 'start' })} /> };
      case 'provider-key': {
        const keyless = step.type === 'ollama' || step.type === 'llamacpp' || step.type === 'openai-compatible';
        return {
          title: `Add ${PROVIDER_LABELS[step.type]}`,
          keys: keys(),
          content: (
            <Box flexDirection="column">
              {step.error && <Text>{paint.fg('bad', step.error)}</Text>}
              <Text>{keyless ? 'The address it listens at:' : `Your ${PROVIDER_LABELS[step.type]} API key (it is kept encrypted on this computer):`}</Text>
              <TextLine
                key={step.type}
                paint={paint}
                mask={!keyless}
                initial={keyless ? DEFAULT_BASE_URLS[step.type] : ''}
                onSubmit={(value) => {
                  if (!value.trim()) return;
                  setStep({ ...step, busy: true, error: undefined });
                  const draft = { id: step.type.replace(/[^a-z0-9]/g, '-'), type: step.type, name: PROVIDER_LABELS[step.type], baseUrl: keyless ? value.trim() : DEFAULT_BASE_URLS[step.type], ...(keyless ? {} : { apiKey: value.trim() }), headers: {}, enabled: true };
                  void rpc()
                    .call('providers.test', draft)
                    .then(async (r) => {
                      if (!r.status.ok) throw new Error(r.status.error ?? 'It didn’t answer.');
                      await rpc().call('providers.save', draft);
                      setStep({ s: 'providers', note: `Added ${PROVIDER_LABELS[step.type]} with ${r.models.length} ${r.models.length === 1 ? 'model' : 'models'}.` });
                    })
                    .catch((e: unknown) => setStep({ ...step, busy: false, error: describe(e) }));
                }}
                onCancel={() => setStep({ s: 'providers' })}
              />
              {step.busy && <Text>{`${spinner} ${paint.fg('muted', 'Checking it…')}`}</Text>}
            </Box>
          ),
        };
      }
      case 'provider-code': {
        const label = PROVIDER_LABELS[step.kind];
        return {
          title: `Sign in to ${label}`,
          keys: 'esc back · ctrl+c quit',
          content: (
            <Box flexDirection="column">
              {step.code ? (
                <>
                  <Text>{step.opened ? 'Your browser opened the page. Enter this code there:' : 'Open this page and enter the code:'}</Text>
                  <Box marginY={1} borderStyle="round" borderColor={paint.p.depth ? paint.p.accent : undefined} paddingX={2} alignSelf="flex-start">
                    <Text>{paint.bold(paint.fg('accent', step.code))}</Text>
                  </Box>
                </>
              ) : (
                <Box marginBottom={1}>
                  <Text>{step.opened ? `Your browser opened the ${label} sign-in. Sign in there, and this goes on by itself.` : `Open this page and sign in to ${label}; this goes on by itself:`}</Text>
                </Box>
              )}
              <Text>{paint.fg(step.opened ? 'muted' : 'info', step.opened ? `If it didn’t open: ${step.url}` : step.url)}</Text>
              <Box marginTop={1}>
                <Text>{`${spinner} ${paint.fg('muted', 'Waiting for the sign-in…')}`}</Text>
              </Box>
              <SignInWait rpc={client!} kind={step.kind} onDone={(n) => setStep({ s: 'providers', note: n })} />
            </Box>
          ),
        };
      }
      case 'model':
        return {
          title: 'Which model, and how much should it ask?',
          keys: '↑/↓ model · ←/→ mode · type to filter · enter continue · esc back',
          content: (
            <ModelStep
              paint={paint}
              models={step.models}
              local={mode === 'local'}
              model={chosenModel?.ref}
              mode={config.permissionMode ?? 'auto'}
              // The frame, the title and the mode take about 20 rows.
              rows={Math.max(4, Math.min(12, rows - 22))}
              onBack={() => setStep(mode === 'local' ? { s: 'providers' } : { s: 'device' })}
              onDone={(m, permissionMode) =>
                void save((c) => ({ ...c, model: m, permissionMode })).then(() => {
                  setChosenModel(m ? { ref: m, name: step.models.find((x) => x.ref === m)?.displayName ?? m } : undefined);
                  setStep({ s: 'done' });
                })
              }
            />
          ),
        };
      case 'done': {
        const term = terminalName();
        const modelName = chosenModel ? chosenModel.name : mode === 'local' ? 'The first model that works' : 'Your account’s default model';
        return {
          title: 'All set',
          keys: 'enter pick · esc back · ctrl+c quit',
          content: (
            <Box flexDirection="column">
              <Text>{`${paint.fg('good', '✓')} ${mode === 'server' ? `Connected to ${server ? hostOf(server.url) : ''} as ${user?.name ?? ''}` : `Running on this computer, as ${user?.name ?? 'you'}`}`}</Text>
              <Text>{`${paint.fg('good', '✓')} ${modelName} · ${MODE_WORDS[config.permissionMode ?? 'auto']}`}</Text>
              {step.note ? <Text>{`${paint.fg('good', '✓')} ${step.note}`}</Text> : term.shiftEnter === 'setup' && <Text>{paint.fg('muted', `New lines: Alt+Enter or Ctrl+J. Shift+Enter needs a setting in ${term.label}.`)}</Text>}
              <Box marginTop={1}>
                <Choices
                  paint={paint}
                  numbered={false}
                  choices={[
                    afterwards === 'session' ? { value: 'go', label: `Start in ${shortPath(process.cwd())}` } : { value: 'go', label: 'Done', aside: `run ${paint.fg('accent', 'atelier')} in a project folder; /help says what you can do` },
                    ...(term.shiftEnter === 'setup' && !step.note ? [{ value: 'shift', label: `Set up Shift+Enter in ${term.label}` }] : []),
                    ...(afterwards === 'session' ? [{ value: 'quit', label: 'Quit for now', aside: 'everything is saved' }] : []),
                  ]}
                  onPick={(v) => (v === 'shift' ? void setupTerminal().then((n) => setStep({ s: 'done', note: n })) : finish(v === 'go' ? config : null))}
                  onCancel={() => void toModel()}
                />
              </Box>
            </Box>
          ),
        };
      }
      default:
        return { title: '', keys: '', content: null };
    }
  })();

  const first = step.s === 'start';
  return (
    <Frame
      paint={paint}
      columns={columns}
      crumbs={first ? undefined : crumbs}
      at={at ?? 0}
      title={body.title}
      keys={body.keys}
      // The wordmark on the first screen of a first setup, where there is room for it.
      top={first && start === 'all' && rows >= 30 ? <Banner paint={paint} columns={columns} motion={initial.motion} /> : undefined}
      pip={pip}
    >
      {/* Keyed by the step, so a list's cursor starts fresh on each one. */}
      <Box key={step.s} flexDirection="column">
        {note && step.s !== 'address' && <Text>{paint.fg('bad', note)}</Text>}
        {body.content}
      </Box>
    </Frame>
  );
}

/** Standalone: what is set up, what was found on this computer, and what can be added. */
function Providers({ paint, rpc, note, onAdd, onCode, onNext, onBack }: { paint: Paint; rpc: RpcClient<AppContract>; note?: string | undefined; onAdd(type: ProviderType): void; onCode(sign: { kind: 'chatgpt' | 'copilot'; url: string; code?: string; opened: boolean }): void; onNext(): void; onBack(): void }) {
  const [state, setState] = useState<{ configured: { id: string; name: string; models: number }[]; detected: { type: ProviderType; baseUrl: string; label: string }[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    void Promise.all([rpc.call('settings.get', {}), rpc.call('providers.status', {}), rpc.call('providers.detect', {}).catch(() => [])]).then(([settings, status, detected]) => {
      const providers = ((settings.effective as { providers?: { id: string; name: string; baseUrl: string }[] }).providers ?? []).map((pr) => ({ ...pr, models: status.find((s) => s.providerId === pr.id)?.modelCount ?? 0 }));
      setState({ configured: providers, detected: detected.filter((d) => d.via === 'port' && !providers.some((pr) => pr.baseUrl === d.baseUrl)) });
    });
  }, [rpc, note, refresh]);
  if (!state) return <Text>{paint.fg('muted', 'Looking at this computer…')}</Text>;
  const addDetected = async (d: { type: ProviderType; baseUrl: string; label: string }) => {
    setBusy(d.label);
    const draft = { id: d.type, type: d.type, name: d.label, baseUrl: d.baseUrl, headers: {}, enabled: true };
    await rpc.call('providers.save', draft).catch(() => undefined);
    setBusy(null);
    setState(null);
    setRefresh((r) => r + 1);
  };
  const signIn = async (kind: 'chatgpt' | 'copilot') => {
    // Signed in already (a sign-in that finished after the setup stopped looking): the provider is all that is missing.
    const status = kind === 'copilot' ? await rpc.call('copilot.status', {}) : await rpc.call('chatgpt.status', {});
    if (status.signedIn) {
      setBusy(PROVIDER_LABELS[kind]);
      await rpc.call('providers.save', { id: kind, type: kind, name: PROVIDER_LABELS[kind], baseUrl: DEFAULT_BASE_URLS[kind], headers: {}, enabled: true }).catch(() => undefined);
      setBusy(null);
      setState(null);
      return setRefresh((r) => r + 1);
    }
    if (kind === 'copilot') {
      const r = await rpc.call('copilot.signIn', {});
      onCode({ kind, url: r.verificationUri, code: r.userCode, opened: openUrl(r.verificationUri) });
    } else {
      // A browser sign-in, as OpenAI's Codex does it; a code only where the backend can't take the browser's answer.
      const r = await rpc.call('chatgpt.signIn', {});
      onCode({ kind, url: r.url, ...(r.userCode ? { code: r.userCode } : {}), opened: openUrl(r.url) });
    }
  };
  const choices: Choice<string>[] = [
    ...state.detected.map((d) => ({ value: `detected:${d.baseUrl}`, label: `Add ${d.label} found here`, hint: d.baseUrl })),
    // Plans already added aren't offered again.
    ...(state.configured.some((c) => c.id === 'chatgpt') ? [] : [{ value: 'chatgpt', label: 'Sign in with a ChatGPT plan' }]),
    ...(state.configured.some((c) => c.id === 'copilot') ? [] : [{ value: 'copilot', label: 'Sign in with GitHub Copilot' }]),
    ...(['anthropic', 'openai', 'mistral', 'mistral-vibe', 'openai-compatible', 'ollama'] as ProviderType[]).map((t) => ({ value: `add:${t}`, label: `Add ${PROVIDER_LABELS[t]}${t === 'openai-compatible' ? ' (OpenRouter, LM Studio, …)' : ''}` })),
    { value: 'next', label: state.configured.length ? 'Continue' : 'Continue without models', ...(state.configured.length ? {} : { hint: 'add one later with atelier setup' }) },
  ];
  return (
    <Box flexDirection="column">
      {note && <Text>{paint.fg('good', note)}</Text>}
      {state.configured.length > 0 && <Text>{`Set up: ${state.configured.map((c) => `${paint.fg('good', '●')} ${c.name}`).join('  ')}`}</Text>}
      {busy && <Text>{paint.fg('muted', `Adding ${busy}…`)}</Text>}
      <Choices
        paint={paint}
        choices={choices}
        numbered={false}
        initial={state.configured.length ? choices.length - 1 : 0}
        onCancel={onBack}
        onPick={(v) => {
          if (v === 'next') return onNext();
          if (v === 'chatgpt' || v === 'copilot') return void signIn(v).catch(() => undefined);
          if (v.startsWith('add:')) return onAdd(v.slice(4) as ProviderType);
          const d = state.detected.find((x) => `detected:${x.baseUrl}` === v);
          if (d) void addDetected(d);
        }}
      />
    </Box>
  );
}

/**
 * Waits for a ChatGPT or Copilot sign-in to finish (their own status says), adds the provider as the desktop app does,
 * and goes back to the list. Esc ends the sign-in. The check runs on its own clock: the wizard redraws many times a
 * second (Pip, the spinner), and a timer that started over with each redraw never fired.
 */
export function SignInWait({ rpc, kind, onDone }: { rpc: RpcClient<AppContract>; kind: 'chatgpt' | 'copilot'; onDone(note: string): void }) {
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    let finished = false;
    const label = PROVIDER_LABELS[kind];
    const finish = (note: string) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      done.current(note);
    };
    const check = async () => {
      const s = kind === 'copilot' ? await rpc.call('copilot.status', {}) : await rpc.call('chatgpt.status', {});
      if (finished) return;
      if (s.signedIn) {
        finished = true;
        clearInterval(timer);
        await rpc
          .call('providers.save', { id: kind, type: kind, name: label, baseUrl: DEFAULT_BASE_URLS[kind], headers: {}, enabled: true })
          .then(
            () => done.current(`Added ${label}.`),
            (e: unknown) => done.current(`Signed in, but ${label} couldn’t be added: ${describe(e)}`),
          );
      } else if (s.error && !s.signingIn) finish(`${label}: ${s.error}`);
    };
    const timer = setInterval(() => void check().catch(() => undefined), 1000);
    return () => {
      finished = true;
      clearInterval(timer);
    };
  }, [rpc, kind]);
  useInput((_i, key) => {
    if (!key.escape) return;
    void (kind === 'copilot' ? rpc.call('copilot.cancel', {}) : rpc.call('chatgpt.cancel', {})).catch(() => undefined);
    done.current('');
  });
  return null;
}

export function runSetup(paths: CliPaths, config: CliConfig, start: SetupStart, shade: Shade, afterwards: 'session' | 'exit' = 'exit'): Promise<CliConfig | null> {
  return new Promise((resolve) => {
    let result: CliConfig | null = null;
    const instance = render(<Wizard paths={paths} config={config} start={start} shade={shade} afterwards={afterwards} onDone={(c) => (result = c)} />, { alternateScreen: true, exitOnCtrlC: false, kittyKeyboard: { mode: 'auto' } });
    void instance.waitUntilExit().then(() => resolve(result));
  });
}
