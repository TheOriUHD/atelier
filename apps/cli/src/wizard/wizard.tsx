/**
 * `atelier setup` (ARCHITECTURE §25): the first-run wizard, full screen. Where Atelier runs (a server, recommended, or
 * only this computer), finding and checking the server, setting up a new one with its setup token, signing in (in the
 * browser with a code, with a password, or with an invite), what this computer lends, providers when standalone, the
 * model, the permission mode and the terminal's Shift+Enter. Each part can be run again on its own.
 */
import { hostname, networkInterfaces } from 'node:os';
import { Box, Text, render, useApp, useAnimation, useInput, useWindowSize } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { contract, createRpcClient, DEFAULT_BASE_URLS, PROVIDER_LABELS, type AppContract, type AppInfo, type ModelInfo, type PermissionMode, type ProviderType, type RpcClient, type TerminalSignInStart, type UserSummary } from '@atelier/protocol';
import { wsTransport, type ReconnectingTransport } from '@atelier/client';
import { applyLending, changeLending, healthCheck, resolveServer, scanNetwork, type FoundServer } from '@atelier/core/device';
import { bigBanner, TAGLINE } from '../art/banner.ts';
import { drawPip, PIP_HELLO, PIP_IDLE } from '../art/mascot.ts';
import { qrLines } from '../art/qr.ts';
import { updateConfig, writePrivate, type CliConfig, type Theme } from '../config.ts';
import { describe, errorCode } from '../connection/connect.ts';
import { cliDevice } from '../daemon/daemon.ts';
import { connectService, serviceTransport } from '../daemon/client.ts';
import { credentialStore, tokenName } from '../keychain.ts';
import type { CliPaths } from '../paths.ts';
import { USER_AGENT, VERSION } from '../runtime.ts';
import { colorDepth, Paint, palette, type Shade } from '../style.ts';
import { openUrl } from '../term.ts';
import { Choices, TextLine, type Choice } from '../tui/inputs.tsx';
import { MODE_WORDS } from '../tui/session.ts';
import { shortPath } from '../tui/views.tsx';
import { setupTerminal, terminalName } from '../commands/terminal-setup.ts';
import { Frame, type Crumb } from './frame.tsx';

export type SetupStart = 'all' | 'login' | 'connect';

type Step =
  | { s: 'splash' }
  | { s: 'look' }
  | { s: 'where' }
  | { s: 'address' }
  | { s: 'checking'; typed: string }
  | { s: 'first-admin'; serverUrl: string; field: number; values: Record<string, string>; error?: string }
  | { s: 'method'; error?: string }
  | { s: 'browser'; start: TerminalSignInStart; opened: boolean }
  | { s: 'password'; field: number; values: Record<string, string>; error?: string }
  | { s: 'invite'; field: number; values: Record<string, string>; error?: string }
  | { s: 'device' }
  | { s: 'local-account'; error?: string }
  | { s: 'providers'; note?: string }
  | { s: 'provider-key'; type: ProviderType; error?: string; busy?: boolean }
  | { s: 'provider-code'; label: string; code: string; url: string }
  | { s: 'model'; models: ModelInfo[] }
  | { s: 'mode' }
  | { s: 'terminal'; note?: string }
  | { s: 'done' };

const CRUMB: Partial<Record<Step['s'], Crumb>> = {
  look: 'look',
  where: 'connect',
  address: 'connect',
  checking: 'connect',
  'first-admin': 'sign in',
  method: 'sign in',
  browser: 'sign in',
  password: 'sign in',
  invite: 'sign in',
  'local-account': 'sign in',
  device: 'this computer',
  providers: 'this computer',
  'provider-key': 'this computer',
  'provider-code': 'this computer',
  model: 'model',
  mode: 'model',
  terminal: 'terminal',
};

interface Props {
  paths: CliPaths;
  config: CliConfig;
  start: SetupStart;
  shade: Shade;
  onDone(config: CliConfig | null): void;
}

const platformName = () => (process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux');

function Splash({ paint, columns, motion, onNext }: { paint: Paint; columns: number; motion: boolean; onNext(): void }) {
  const { frame } = useAnimation({ interval: 60, isActive: motion && paint.p.depth > 0 });
  const reveal = motion ? Math.min(1, frame / 28) : 1;
  const pipFrame = motion ? (frame < 40 ? 'base' : PIP_HELLO[Math.floor((frame - 40) / 3) % PIP_HELLO.length]!) : 'base';
  useInput((_i, key) => key.return && onNext());
  return (
    <Box flexDirection="column" alignItems="center" width={columns} marginTop={1}>
      <Text>{bigBanner(paint, columns, reveal).join('\n')}</Text>
      <Box marginTop={1}>
        <Text>{drawPip(pipFrame, paint.p.depth).join('\n')}</Text>
      </Box>
      <Text>{paint.fg('secondary', TAGLINE)}</Text>
      <Box marginTop={1}>
        <Text>{paint.fg('muted', reveal >= 1 ? 'press enter to begin' : ' ')}</Text>
      </Box>
    </Box>
  );
}

/** One field after another (hidden for passwords and tokens). */
function Fields({ paint, fields, step, values, onValue, onBack }: { paint: Paint; fields: { name: string; label: string; mask?: boolean; placeholder?: string; initial?: string }[]; step: number; values: Record<string, string>; onValue(name: string, value: string): void; onBack(): void }) {
  return (
    <Box flexDirection="column">
      {fields.slice(0, step).map((f) => (
        <Text key={f.name}>{`${paint.fg('good', '✓')} ${f.label}  ${paint.fg('muted', f.mask ? '•'.repeat(Math.min(12, values[f.name]?.length ?? 0)) : (values[f.name] ?? ''))}`}</Text>
      ))}
      {fields[step] && (
        <Box flexDirection="column" marginTop={step ? 1 : 0}>
          <Text>{fields[step].label}</Text>
          <TextLine key={fields[step].name} paint={paint} mask={!!fields[step].mask} placeholder={fields[step].placeholder ?? ''} initial={fields[step].initial ?? values[fields[step].name] ?? ''} onSubmit={(v) => v.trim() && onValue(fields[step]!.name, fields[step]!.mask ? v : v.trim())} onCancel={onBack} />
        </Box>
      )}
    </Box>
  );
}

function Wizard({ paths, config: initial, start, shade, onDone }: Props) {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const [config, setConfig] = useState(initial);
  const [theme, setTheme] = useState<Theme>(initial.theme === 'plain' ? 'plain' : initial.theme);
  const depth = theme === 'plain' ? 0 : colorDepth();
  const paint = new Paint(palette(theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : shade, depth));
  const [step, setStep] = useState<Step>(start === 'login' && initial.connection?.mode === 'server' ? { s: 'checking', typed: initial.connection.serverUrl } : start === 'connect' ? { s: 'where' } : { s: 'splash' });
  const [found, setFound] = useState<FoundServer[]>([]);
  const [scanning, setScanning] = useState(true);
  const [server, setServer] = useState<{ url: string; info: AppInfo | null } | null>(null);
  const [user, setUser] = useState<UserSummary | null>(null);
  const [mode, setMode] = useState<'server' | 'local' | null>(initial.connection?.mode ?? null);
  const rpcRef = useRef<{ rpc: RpcClient<AppContract>; transport: ReconnectingTransport } | null>(null);
  /** The same client for what is drawn (a ref isn't read while rendering). */
  const [client, setClient] = useState<RpcClient<AppContract> | null>(null);
  const [lend, setLend] = useState({ scratch: true, home: true });
  const [deviceName] = useState(`${hostname().replace(/\.local$/, '')} · terminal`);
  const [chosenModel, setChosenModel] = useState<string | undefined>(initial.model);
  const { frame } = useAnimation({ interval: 140, isActive: depth > 0 && initial.motion });

  const finish = (result: CliConfig | null) => {
    rpcRef.current?.transport.close();
    onDone(result);
    exit();
  };
  const save = async (change: (c: CliConfig) => CliConfig) => setConfig(await updateConfig(paths.config, change));

  // Look for servers on the network while the person reads the first screens.
  useEffect(() => {
    void scanNetwork({ interfaces: networkInterfaces(), fetch, onFound: (s) => setFound((list) => (list.some((x) => x.url === s.url) ? list : [...list, s])) }).finally(() => setScanning(false));
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') finish(null);
  });

  const rpc = () => rpcRef.current!.rpc;

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

  const checkServer = async (typed: string) => {
    try {
      const resolved = await resolveServer(typed, healthCheck());
      const url = resolved.serverUrl;
      openServer(url);
      const info = await rpc().call('app.info', {});
      setServer({ url, info });
      const status = await rpc().call('auth.status', {});
      if (status.setupRequired) return setStep({ s: 'first-admin', serverUrl: url, field: 0, values: {} });
      setStep({ s: 'method' });
    } catch (e) {
      setStep({ s: 'address' });
      setNote(`Couldn’t reach Atelier at ${typed}: ${describe(e)}`);
    }
  };
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (step.s === 'checking') void checkServer(step.typed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.s === 'checking' ? step.typed : null]);

  // Browser sign-in: poll until the person approves it in the browser.
  useEffect(() => {
    if (step.s !== 'browser') return;
    let stop = false;
    const poll = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, step.start.interval * 1000));
        if (stop) return;
        try {
          const r = await rpc().call('auth.terminalPoll', { pollToken: step.start.pollToken });
          if (r.state === 'approved') return void (await signedIn(r));
          if (r.state === 'denied') return setStep({ s: 'method', error: 'The sign-in was denied in the browser.' });
          if (r.state === 'expired') return setStep({ s: 'method', error: 'The code expired. Start again.' });
        } catch {
          // A dropped connection: the next poll goes through the reconnected socket.
        }
      }
    };
    void poll();
    return () => void (stop = true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.s === 'browser' ? step.start.pollToken : null]);

  const startBrowser = async () => {
    try {
      const startInfo = await rpc().call('auth.terminalStart', { deviceName, platform: platformName() });
      const opened = openUrl(startInfo.verifyUrlComplete);
      setStep({ s: 'browser', start: startInfo, opened });
    } catch (e) {
      setStep({ s: 'method', error: describe(e) });
    }
  };

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

  const crumb = CRUMB[step.s] ?? null;
  const frameKeys = 'enter continue · esc back · ctrl+c quit';
  const pip = drawPip(initial.motion && depth ? PIP_IDLE[frame % PIP_IDLE.length]! : 'base', depth);

  if (step.s === 'splash') return <Splash paint={paint} columns={columns} motion={initial.motion} onNext={() => setStep({ s: 'look' })} />;

  const body = (() => {
    switch (step.s) {
      case 'look': {
        const choices: Choice<Theme>[] = [
          { value: 'auto', label: 'Match the terminal', hint: `it looks ${shade} here` },
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'plain', label: 'No colour', hint: 'for screen readers and plain terminals' },
        ];
        const sample = new Paint(palette(theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : shade, theme === 'plain' ? 0 : colorDepth()));
        return {
          title: 'How should it look?',
          content: (
            <Box flexDirection="row" gap={4}>
              <Choices paint={paint} choices={choices} initial={['auto', 'dark', 'light', 'plain'].indexOf(theme)} onMove={(i) => setTheme(choices[i]!.value)} onPick={(t) => void save((c) => ({ ...c, theme: t })).then(() => setStep({ s: 'where' }))} onCancel={() => setStep({ s: 'splash' })} />
              <Box flexDirection="column">
                <Text>{`${sample.fg('accent', '◆')} I'll slow the wave down.`}</Text>
                <Text>{`${sample.fg('good', '●')} ${sample.bold('Edited')} shaders/water.fsh ${sample.fg('added', '+1')} ${sample.fg('removed', '−1')}`}</Text>
                <Text>{sample.bg(sample.p.removedBg, sample.fg('removed', '41 - ') + 'float t = time * 2.0;')}</Text>
                <Text>{sample.bg(sample.p.addedBg, sample.fg('added', '41 + ') + 'float t = time * 0.8;')}</Text>
              </Box>
            </Box>
          ),
        };
      }
      case 'where':
        return {
          title: 'Where should Atelier run?',
          content: (
            <Box flexDirection="column">
              <Choices
                paint={paint}
                showHints="all"
                choices={[
                  { value: 'server', label: 'An Atelier server  (recommended)', hint: 'Models and keys are set up once, on the server. Sessions follow you to the browser, the desktop app and your phone. This computer lends the folders you open.' },
                  { value: 'local', label: 'Only this computer', hint: 'Your own models and keys, kept here. Sessions stay in the terminal.' },
                ]}
                onPick={(v) => (v === 'server' ? (setMode('server'), setStep({ s: 'address' })) : void toLocal().catch((e: unknown) => setNote(describe(e))))}
                onCancel={() => setStep({ s: 'look' })}
              />
              <Box marginTop={1}>
                <Text>{paint.fg('muted', found.length ? `Found on your network: ${found.map((f) => `${paint.fg('good', '●')} ${new URL(f.url).host}${f.version ? ` (${f.version})` : ''}`).join('   ')}` : scanning ? 'Looking for servers on your network…' : 'No server found on your network (one elsewhere works too).')}</Text>
              </Box>
            </Box>
          ),
        };
      case 'address':
        return {
          title: 'Which server?',
          content: (
            <Box flexDirection="column">
              {note && <Text>{paint.fg('bad', note)}</Text>}
              {found.length > 0 && <Choices paint={paint} numbered choices={[...found.map((f) => ({ value: f.url, label: new URL(f.url).host, hint: `Atelier ${f.version ?? ''}` })), { value: '', label: 'Another address…' }]} onPick={(v) => (v ? (setNote(null), setStep({ s: 'checking', typed: v })) : setFound([]))} onCancel={() => setStep({ s: 'where' })} />}
              {found.length === 0 && (
                <>
                  <Text>The address you open it at in the browser:</Text>
                  <TextLine paint={paint} placeholder="atelier.example.com" initial={initial.connection?.mode === 'server' ? initial.connection.serverUrl : ''} onSubmit={(v) => v.trim() && (setNote(null), setStep({ s: 'checking', typed: v.trim() }))} onCancel={() => setStep({ s: 'where' })} />
                  <Text>{paint.fg('muted', 'https:// is tried first; http:// only for addresses on your own network.')}</Text>
                </>
              )}
            </Box>
          ),
        };
      case 'checking':
        return { title: 'Checking the server…', content: <Text>{paint.fg('muted', `Asking ${step.typed} whether it is Atelier…`)}</Text> };
      case 'first-admin': {
        const fields = [
          { name: 'token', label: 'The setup token from the server’s log', mask: true },
          { name: 'name', label: 'Your name' },
          { name: 'username', label: 'Username', placeholder: 'lowercase, like ada' },
          { name: 'password', label: 'Password (at least 10 characters)', mask: true },
        ];
        return {
          title: `${new URL(step.serverUrl).host} isn’t set up yet`,
          content: (
            <Box flexDirection="column">
              <Text>{paint.fg('muted', 'You make its first account here, the admin. The setup token is printed in the server’s log (`docker compose logs atelier`).')}</Text>
              {step.error && <Text>{paint.fg('bad', step.error)}</Text>}
              <Fields
                paint={paint}
                fields={fields}
                step={step.field}
                values={step.values}
                onBack={() => setStep({ s: 'address' })}
                onValue={(name, value) => {
                  const values = { ...step.values, [name]: value };
                  if (step.field + 1 < fields.length) return setStep({ ...step, field: step.field + 1, values, error: undefined });
                  void rpc()
                    .call('auth.setup', { setupToken: values.token!, name: values.name!, username: values.username!, password: values.password!, clientKind: 'cli' })
                    .then(signedIn)
                    .catch((e: unknown) => setStep({ ...step, field: errorCode(e) === 'invalid_setup_token' ? 0 : 2, values, error: describe(e) }));
                }}
              />
            </Box>
          ),
        };
      }
      case 'method': {
        const browser = !!server?.info?.terminalSignIn;
        return {
          title: `Sign in to ${server ? new URL(server.url).host : 'the server'}`,
          content: (
            <Box flexDirection="column">
              {step.error && <Text>{paint.fg('bad', step.error)}</Text>}
              {!browser && <Text>{paint.fg('muted', `This server (Atelier ${server?.info?.version ?? 'older'}) signs terminals in with a password only. Version ${VERSION} adds signing in through the browser.`)}</Text>}
              <Choices
                paint={paint}
                showHints="all"
                choices={[
                  ...(browser ? [{ value: 'browser', label: 'In the browser  (recommended)', hint: 'Approve this terminal where you are signed in: a password, a passkey or single sign-on all work.' }] : []),
                  { value: 'password', label: 'With my username and password' },
                  { value: 'invite', label: 'I have an invite code', hint: 'makes your account' },
                ]}
                onPick={(v) => (v === 'browser' ? void startBrowser() : v === 'password' ? setStep({ s: 'password', field: 0, values: {} }) : setStep({ s: 'invite', field: 0, values: {} }))}
                onCancel={() => setStep({ s: 'address' })}
              />
            </Box>
          ),
        };
      }
      case 'browser': {
        const code = step.start.code;
        const big = [...code].map((ch) => (ch === '-' ? ' ' : ch)).join(' ');
        return {
          title: 'Approve this terminal in the browser',
          content: (
            <Box flexDirection="row" gap={3}>
              <Box flexDirection="column">
                <Text>{step.opened ? 'Your browser opened the page. Check that it shows this code:' : 'Open this page where you are signed in:'}</Text>
                <Text>{paint.fg('info', step.start.verifyUrlComplete)}</Text>
                <Box marginY={1} borderStyle="round" borderColor={paint.p.depth ? paint.p.accent : undefined} paddingX={2}>
                  <Text>{paint.bold(paint.fg('accent', big))}</Text>
                </Box>
                <Text>{paint.fg('muted', 'Or scan it with your phone. The code works for 10 minutes.')}</Text>
                <Text>{`${paint.fg('accent', '◎')} ${paint.fg('secondary', 'Waiting for you to approve it…')}`}</Text>
              </Box>
              <Text>{qrLines(step.start.verifyUrlComplete, paint.p.shade).join('\n')}</Text>
            </Box>
          ),
        };
      }
      case 'password': {
        const fields = [
          { name: 'username', label: 'Username', initial: initial.connection?.mode === 'server' ? (initial.connection.username ?? '') : '' },
          { name: 'password', label: 'Password', mask: true },
        ];
        return {
          title: `Sign in to ${server ? new URL(server.url).host : 'the server'}`,
          content: (
            <Box flexDirection="column">
              {step.error && <Text>{paint.fg('bad', step.error)}</Text>}
              <Fields
                paint={paint}
                fields={fields}
                step={step.field}
                values={step.values}
                onBack={() => setStep({ s: 'method' })}
                onValue={(name, value) => {
                  const values = { ...step.values, [name]: value };
                  if (step.field + 1 < fields.length) return setStep({ ...step, field: step.field + 1, values, error: undefined });
                  void rpc()
                    .call('auth.login', { username: values.username!.toLowerCase(), password: values.password!, clientKind: 'cli' })
                    .then(signedIn)
                    .catch((e: unknown) => setStep({ s: 'password', field: 1, values, error: describe(e) }));
                }}
              />
            </Box>
          ),
        };
      }
      case 'invite': {
        const fields = [
          { name: 'invite', label: 'Invite code', placeholder: 'XXXX-XXXX-XXXX-XXXX' },
          { name: 'name', label: 'Your name' },
          { name: 'username', label: 'Username' },
          { name: 'password', label: 'Password (at least 10 characters)', mask: true },
        ];
        return {
          title: 'Make your account',
          content: (
            <Box flexDirection="column">
              {step.error && <Text>{paint.fg('bad', step.error)}</Text>}
              <Fields
                paint={paint}
                fields={fields}
                step={step.field}
                values={step.values}
                onBack={() => setStep({ s: 'method' })}
                onValue={(name, value) => {
                  const values = { ...step.values, [name]: value };
                  if (step.field + 1 < fields.length) return setStep({ ...step, field: step.field + 1, values, error: undefined });
                  void rpc()
                    .call('auth.acceptInvite', { invite: values.invite!, name: values.name!, username: values.username!.toLowerCase(), password: values.password!, clientKind: 'cli' })
                    .then(signedIn)
                    .catch((e: unknown) => setStep({ s: 'invite', field: 0, values, error: describe(e) }));
                }}
              />
            </Box>
          ),
        };
      }
      case 'device':
        return {
          title: 'What this computer lends the server',
          content: (
            <Box flexDirection="column">
              <Text>{`Signed in as ${paint.bold(user?.name ?? '')}. This computer shows on the server as ${paint.bold(deviceName)}.`}</Text>
              <Box marginTop={1} flexDirection="column">
                <Choices
                  paint={paint}
                  showHints="all"
                  choices={[
                    { value: 'scratch', label: `${lend.scratch ? '☒' : '☐'} New empty folders here`, hint: 'for sessions started without a folder (the browser’s “No folder”)' },
                    { value: 'home', label: `${lend.home ? '☒' : '☐'} Your skills and instructions`, hint: 'from ~/.claude and ~/.atelier, as in the desktop app' },
                    { value: 'go', label: 'Continue' },
                  ]}
                  initial={2}
                  onPick={(v) => {
                    if (v === 'scratch' || v === 'home') return setLend({ ...lend, [v]: !lend[v] });
                    void (async () => {
                      const device = await cliDevice(paths);
                      if (device.name !== deviceName) await writePrivate(paths.device, `${JSON.stringify({ ...device, name: deviceName }, null, 2)}\n`);
                      await changeLending(paths.lending, server!.url, (current) => applyLending(applyLending(current, { kind: 'scratch', allowed: lend.scratch }), { kind: 'home', allowed: lend.home }));
                      await rpc().call('devices.register', { ...device, name: deviceName }).catch(() => undefined);
                      await toModel();
                    })().catch((e: unknown) => setNote(describe(e)));
                  }}
                  onCancel={() => setStep({ s: 'method' })}
                />
              </Box>
              <Box marginTop={1}>
                <Text>{paint.fg('warn', 'Folders you open in the terminal let your server’s sessions run commands as you on this computer. Only connect to a server you trust like that.')}</Text>
              </Box>
            </Box>
          ),
        };
      case 'local-account':
        return {
          title: 'What should Atelier call you?',
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
                onCancel={() => setStep({ s: 'where' })}
              />
              <Text>{paint.fg('muted', 'Everything stays on this computer, in ~/.atelier/cli.')}</Text>
            </Box>
          ),
        };
      case 'providers':
        return { title: 'Which models?', content: <Providers paint={paint} rpc={client!} note={step.note} onAdd={(type) => setStep({ s: 'provider-key', type })} onCode={(label, code, url) => setStep({ s: 'provider-code', label, code, url })} onNext={() => void toModel()} onBack={() => setStep({ s: 'where' })} /> };
      case 'provider-key': {
        const keyless = step.type === 'ollama' || step.type === 'llamacpp' || step.type === 'openai-compatible';
        return {
          title: `Add ${PROVIDER_LABELS[step.type]}`,
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
              {step.busy && <Text>{paint.fg('muted', 'Checking it…')}</Text>}
            </Box>
          ),
        };
      }
      case 'provider-code':
        return {
          title: `Sign in to ${step.label}`,
          content: (
            <Box flexDirection="column">
              <Text>{`Open ${paint.fg('info', step.url)} and enter`}</Text>
              <Box marginY={1} borderStyle="round" borderColor={paint.p.depth ? paint.p.accent : undefined} paddingX={2}>
                <Text>{paint.bold(paint.fg('accent', step.code))}</Text>
              </Box>
              <Text>{paint.fg('muted', 'Waiting for the sign-in… (esc goes back)')}</Text>
              <CodeWait rpc={client!} label={step.label} onDone={(n) => setStep({ s: 'providers', note: n })} />
            </Box>
          ),
        };
      case 'model': {
        const items: Choice<string>[] = [{ value: '', label: 'My account’s default', hint: 'what the browser and the app start Code sessions with' }, ...step.models.slice(0, 30).map((m) => ({ value: m.ref, label: m.displayName, hint: m.ref }))];
        return {
          title: 'Which model should new sessions use?',
          content: step.models.length ? (
            <Choices paint={paint} choices={items} numbered={false} initial={Math.max(0, items.findIndex((i) => i.value === chosenModel))} onPick={(v) => void save((c) => ({ ...c, model: v || undefined })).then(() => (setChosenModel(v || undefined), setStep({ s: 'mode' })))} onCancel={() => setStep(mode === 'local' ? { s: 'providers' } : { s: 'device' })} />
          ) : (
            <Box flexDirection="column">
              <Text>{paint.fg('warn', mode === 'local' ? 'No models yet: add a provider first.' : 'This server has no models for you yet. An admin adds providers in Settings › Admin › Providers.')}</Text>
              <Choices paint={paint} choices={[{ value: 'go', label: 'Continue anyway' }, { value: 'back', label: 'Back' }]} onPick={(v) => (v === 'go' ? setStep({ s: 'mode' }) : setStep(mode === 'local' ? { s: 'providers' } : { s: 'device' }))} />
            </Box>
          ),
        };
      }
      case 'mode':
        return {
          title: 'How much should it ask?',
          content: (
            <Choices
              paint={paint}
              showHints="all"
              choices={(['auto', 'default', 'acceptEdits'] as PermissionMode[]).map((m) => ({
                value: m,
                label: `${MODE_WORDS[m]}${m === 'auto' ? '  (recommended)' : ''}`,
                hint: m === 'auto' ? 'A reviewing model lets through what you asked for and asks you about the rest.' : m === 'default' ? 'Asks you before every edit and command.' : 'Edits files freely; commands still ask.',
              }))}
              onPick={(m) => void save((c) => ({ ...c, permissionMode: m })).then(() => setStep({ s: 'terminal' }))}
              onCancel={() => setStep({ s: 'model', models: [] })}
            />
          ),
        };
      case 'terminal': {
        const name = terminalName();
        return {
          title: 'Your terminal',
          content: (
            <Box flexDirection="column">
              {step.note && <Text>{paint.fg('good', step.note)}</Text>}
              <Text>{`New lines: Alt+Enter and Ctrl+J work everywhere. ${name.shiftEnter === 'native' ? `${name.label} sends Shift+Enter as it is.` : name.shiftEnter === 'setup' ? `Shift+Enter needs a setting in ${name.label}.` : ''}`}</Text>
              <Box marginTop={1}>
                <Choices
                  paint={paint}
                  choices={[
                    ...(name.shiftEnter === 'setup' ? [{ value: 'setup', label: `Set up Shift+Enter in ${name.label}` }] : []),
                    { value: 'go', label: 'Continue' },
                  ]}
                  onPick={(v) => (v === 'setup' ? void setupTerminal().then((n) => setStep({ s: 'terminal', note: n })) : setStep({ s: 'done' }))}
                  onCancel={() => setStep({ s: 'mode' })}
                />
              </Box>
            </Box>
          ),
        };
      }
      case 'done':
        return {
          title: 'All set',
          content: (
            <Box flexDirection="column">
              <Text>{`${paint.fg('good', '✓')} ${mode === 'server' ? `Connected to ${server ? new URL(server.url).host : ''} as ${user?.name ?? ''}` : `Running on this computer, as ${user?.name ?? 'you'}`}`}</Text>
              <Text>{`${paint.fg('good', '✓')} Model: ${chosenModel ?? 'your account’s default'}`}</Text>
              <Text>{`${paint.fg('good', '✓')} Mode: ${MODE_WORDS[config.permissionMode ?? 'auto']}`}</Text>
              <Box marginTop={1}>
                <Text>{`Run ${paint.fg('accent', 'atelier')} in a project folder. ${paint.fg('muted', '/help shows what you can do.')}`}</Text>
              </Box>
              <Choices paint={paint} choices={[{ value: 'start', label: `Start now in ${shortPath(process.cwd())}` }, { value: 'quit', label: 'Done' }]} onPick={(v) => finish(v === 'start' ? config : { ...config, connection: config.connection })} />
            </Box>
          ),
        };
      default:
        return { title: '', content: null };
    }
  })();

  return (
    <Frame paint={paint} columns={columns} crumb={crumb} title={body.title} keys={frameKeys}>
      <Box flexDirection="row" gap={2}>
        {/* Keyed by the step, so a list's cursor starts fresh on each one. */}
        <Box key={step.s} flexDirection="column" flexGrow={1}>
          {note && step.s !== 'address' && <Text>{paint.fg('bad', note)}</Text>}
          {body.content}
        </Box>
        {columns >= 96 && step.s !== 'browser' && step.s !== 'look' && <Text>{pip.join('\n')}</Text>}
      </Box>
    </Frame>
  );
}

/** Standalone: what is set up, what was found on this computer, and what can be added. */
function Providers({ paint, rpc, note, onAdd, onCode, onNext, onBack }: { paint: Paint; rpc: RpcClient<AppContract>; note?: string | undefined; onAdd(type: ProviderType): void; onCode(label: string, code: string, url: string): void; onNext(): void; onBack(): void }) {
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
    if (kind === 'copilot') {
      const r = await rpc.call('copilot.signIn', {});
      openUrl(r.verificationUri);
      onCode('GitHub Copilot', r.userCode, r.verificationUri);
    } else {
      const r = await rpc.call('chatgpt.signIn', {});
      openUrl(r.url);
      onCode('ChatGPT Plan', r.userCode ?? 'Sign in in the browser that opened', r.url);
    }
  };
  const choices: Choice<string>[] = [
    ...state.detected.map((d) => ({ value: `detected:${d.baseUrl}`, label: `Add ${d.label} found here`, hint: d.baseUrl })),
    { value: 'chatgpt', label: 'Sign in with a ChatGPT plan' },
    { value: 'copilot', label: 'Sign in with GitHub Copilot' },
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

/** Waits for a ChatGPT or Copilot sign-in to finish (their own status says), then goes back to the list. */
function CodeWait({ rpc, label, onDone }: { rpc: RpcClient<AppContract>; label: string; onDone(note: string): void }) {
  useEffect(() => {
    const timer = setInterval(() => {
      const check = label === 'GitHub Copilot' ? rpc.call('copilot.status', {}) : rpc.call('chatgpt.status', {});
      void check
        .then((s) => {
          if (s.signedIn) onDone(`Signed in to ${label}.`);
          else if (s.error && !s.signingIn) onDone(`${label}: ${s.error}`);
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [rpc, label, onDone]);
  useInput((_i, key) => key.escape && onDone(''));
  return null;
}

export function runSetup(paths: CliPaths, config: CliConfig, start: SetupStart, shade: Shade): Promise<CliConfig | null> {
  return new Promise((resolve) => {
    let result: CliConfig | null = null;
    const instance = render(<Wizard paths={paths} config={config} start={start} shade={shade} onDone={(c) => (result = c)} />, { alternateScreen: true, exitOnCtrlC: false, kittyKeyboard: { mode: 'auto' } });
    void instance.waitUntilExit().then(() => resolve(result));
  });
}
