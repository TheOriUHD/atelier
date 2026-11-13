/**
 * Atelier CLI (ARCHITECTURE §25): `atelier` in a folder starts a Code session there, on this computer's own backend or
 * an Atelier server's, laid out like Claude Code. This file reads the command line and sends it on: the session screen,
 * print mode, the setup wizard, and the small commands.
 */
import module from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { render } from 'ink';
import { createElement } from 'react';
import type { Effort, PermissionMode } from '@atelier/protocol';
import { helpText, parse } from './args.ts';
import { bigBanner } from './art/banner.ts';
import { drawPip } from './art/mascot.ts';
import { readConfig, updateConfig, type CliConfig } from './config.ts';
import { connect, describe, NeedsSetup, type Connected } from './connection/connect.ts';
import { folderRoot, knownFolder, trustedHere, trustFolder } from './connection/folder.ts';
import { connectService, stopService } from './daemon/client.ts';
import { credentialStore, tokenName } from './keychain.ts';
import { paths as cliPaths } from './paths.ts';
import { VERSION } from './runtime.ts';
import { colorDepth, Paint, palette, type Shade } from './style.ts';
import { backgroundShade, FOCUS_OFF, holdInput, interactive, MOUSE_OFF, MOUSE_ON } from './term.ts';
import type { AppExit } from './tui/commands.ts';
import { mouseInput } from './tui/mouse.ts';
import { setInstance } from './tui/screen.ts';
import { defaultCodeModel, modeFrom } from './tui/session.ts';

module.enableCompileCache?.();
const run = promisify(execFile);
// `atelier licenses | head`: the reader went away, which is fine.
process.stdout.on('error', (e: NodeJS.ErrnoException) => e.code === 'EPIPE' && process.exit(0));
// A call that failed with nothing waiting for it (the service restarting under a session, a session deleted elsewhere)
// goes to the log; Node would otherwise end the whole app on the first one. The service keeps its own log.
process.on('unhandledRejection', (e) => {
  if (process.env.ATELIER_DAEMON === '1') return;
  const line = `${new Date().toISOString()} unhandled ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`;
  void import('node:fs/promises').then(({ appendFile, mkdir }) => {
    const p = cliPaths();
    return mkdir(p.logs, { recursive: true }).then(() => appendFile(`${p.logs}/cli.log`, line));
  }).catch(() => undefined);
});

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  const p = cliPaths();
  let config = await readConfig(p.config);
  const plain = !!values.plain || !!values['screen-reader'] || config.theme === 'plain';
  const depth = plain ? 0 : colorDepth();
  const needsShade = config.theme === 'auto' && depth > 0 && process.stdin.isTTY;
  const shade: Shade = config.theme === 'light' ? 'light' : config.theme === 'dark' ? 'dark' : needsShade ? await backgroundShade() : 'dark';
  const paint = new Paint(palette(shade, depth));
  if (plain) config = { ...config, motion: false };
  const [command, ...rest] = positionals;

  if (values.version) {
    if (process.stdout.isTTY && !plain) process.stdout.write(`${bigBanner(paint, process.stdout.columns ?? 80).join('\n')}\n${paint.fg('muted', `Atelier CLI ${VERSION}`)}\n`);
    else process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || command === 'help') {
    process.stdout.write(`${helpText(paint)}\n`);
    return 0;
  }

  switch (command) {
    case 'daemon':
      return daemonCommand(rest, values, p, config);
    case 'setup':
      return (await setup(p, config, 'all', shade)) ? 0 : 1;
    case 'login':
      if (!config.connection || config.connection.mode !== 'server') {
        process.stderr.write('This terminal isn’t connected to a server. atelier setup connects it.\n');
        return 1;
      }
      return (await setup(p, config, 'login', shade)) ? 0 : 1;
    case 'logout':
      return logout(p, config);
    case 'connect': {
      if (values.local) {
        await updateConfig(p.config, (c) => ({ ...c, connection: { mode: 'local' } }));
        process.stdout.write('This terminal now works on this computer only.\n');
        return 0;
      }
      if (rest[0]) config = { ...config, connection: { mode: 'server', serverUrl: rest[0].includes('://') ? rest[0] : `https://${rest[0]}` } };
      return (await setup(p, config, rest[0] ? 'login' : 'connect', shade)) ? 0 : 1;
    }
    case 'doctor': {
      const { runChecks } = await import('./commands/doctor.ts');
      process.stdout.write(`${(await runChecks(p, paint)).join('\n')}\n`);
      return 0;
    }
    case 'update':
      return updateCommand(config, p, !!values.beta, paint);
    case 'reset-keys':
      return resetKeys(p, config, !!values.force);
    case 'completion': {
      const { completion } = await import('./commands/completion.ts');
      const script = completion(rest[0] ?? '');
      if (!script) {
        process.stderr.write('Which shell? atelier completion bash|zsh|fish|pwsh\n');
        return 1;
      }
      process.stdout.write(script);
      return 0;
    }
    case 'licenses': {
      const { readFile } = await import('node:fs/promises');
      const { here } = await import('./runtime.ts');
      const { join } = await import('node:path');
      process.stdout.write(await readFile(join(here(), 'LICENSES.txt'), 'utf8').catch(() => 'The licenses are in THIRD_PARTY_NOTICES.md of the source.\n'));
      return 0;
    }
    case 'token': {
      if (config.connection?.mode !== 'server') {
        process.stderr.write('This terminal isn’t connected to a server.\n');
        return 1;
      }
      const token = await (await credentialStore(p.credentials)).get(tokenName(config.connection.serverUrl));
      if (!token) {
        process.stderr.write('Not signed in: atelier login\n');
        return 3;
      }
      process.stderr.write(`This is your sign-in to ${new URL(config.connection.serverUrl).host}: anyone with it works as you. Keep it in your CI's secrets (ATELIER_TOKEN); signing this terminal out ends it.\n`);
      process.stdout.write(`${token}\n`);
      return 0;
    }
    case 'status':
    case 'models':
    case 'sessions':
      return listCommand(command, p, config, paint);
    default:
      break;
  }

  // A session: first make sure there is somewhere to run it.
  const prompt = [command, ...rest].filter(Boolean).join(' ').trim();
  const printMode = !!values.print || (!process.stdin.isTTY && !process.stdout.isTTY);
  let input = prompt;
  if (printMode && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const piped = Buffer.concat(chunks).toString('utf8').trim();
    input = [prompt, piped].filter(Boolean).join('\n\n');
  }
  const server = typeof values.server === 'string' ? values.server : process.env.ATELIER_SERVER;
  if (server) config = { ...config, connection: { mode: 'server', serverUrl: server.replace(/\/$/, '') } };

  let conn: Connected;
  for (;;) {
    try {
      conn = await connect(p, config);
      break;
    } catch (e) {
      if (!(e instanceof NeedsSetup) || printMode || !process.stdin.isTTY) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        return e instanceof NeedsSetup ? 3 : 1;
      }
      const next = await setup(p, config, e.reason === 'signed-out' ? 'login' : 'all', shade, 'session');
      if (!next) return 1;
      config = next;
    }
  }

  try {
    const root = await folderRoot(process.cwd());
    // A desktop app shared on its network works only in the folders opened in that app: a terminal can't lend it its own.
    if (conn.mode === 'server' && (await conn.rpc.call('app.info', {}).catch(() => null))?.sharedComputer) {
      process.stderr.write(
        `${new URL(conn.serverUrl!).host} is the Atelier desktop app, shared on its network. It works only in folders opened in that app, so it can't work in ${root} from here.\n` +
          `To work here from the terminal: atelier connect --local (Atelier on this computer, with its own models), or connect to an Atelier server.\n`,
      );
      return 1;
    }
    let folder = await knownFolder(conn, root);
    const trusted = conn.mode === 'local' || (folder && (await trustedHere(p, root)));
    if (!folder || !trusted) {
      if (printMode) {
        process.stderr.write(`Atelier hasn’t worked in ${root} yet. Run atelier there once to say it may.\n`);
        return 1;
      }
      const { askTrust } = await import('./tui/trust.tsx');
      if (!(await askTrust(paint, root, conn.mode === 'server' ? new URL(conn.serverUrl!).host : null))) return 0;
      folder = await trustFolder(conn, p, root);
    }
    const models = await conn.rpc.call('models.list', {}).catch(() => []);
    const wantedModel = typeof values.model === 'string' ? values.model : config.model;
    const { findModel } = await import('./tui/session.ts');
    const named = wantedModel ? findModel(models, wantedModel) : undefined;
    const model = named ?? (await defaultCodeModel(conn.rpc, models, config.model));
    if (wantedModel && !named) process.stderr.write(`${paint.fg('warn', `The model “${wantedModel}” isn’t one you can use here${model ? `; using ${model.displayName} (${model.ref})` : ''}. atelier models lists them.`)}\n`);
    const modeWord = (values.mode ?? values['permission-mode']) as string | undefined;
    const mode: PermissionMode | undefined = modeWord ? (modeFrom(modeWord) ?? undefined) : undefined;
    const effort = typeof values.effort === 'string' ? (values.effort === 'extra' ? 'xhigh' : values.effort) as Effort : undefined;

    // Which session: the latest here (-c), one by id, or a new one.
    let sessionId: string | null = typeof values.session === 'string' ? values.session : null;
    if (values.continue || values.resume) {
      const list = await conn.rpc.call('sessions.list', { mode: 'code', limit: 50 });
      const here = list.filter((s) => s.workspaceId === folder.id).sort((a, b) => b.updatedAt - a.updatedAt);
      if (values.resume && positionals[0] && list.some((s) => s.id === positionals[0])) sessionId = positionals[0]!;
      else if (values.continue) sessionId = here[0]?.id ?? null;
    }

    if (printMode) {
      if (!input) {
        process.stderr.write('Nothing to ask: atelier -p "your prompt" (or pipe it in).\n');
        return 1;
      }
      const { runPrint } = await import('./commands/print.ts');
      const allow = ([] as string[]).concat((values.allow as string[] | string | undefined) ?? []);
      return await runPrint({ conn, folder, prompt: input, format: (values['output-format'] as 'text' | 'json' | 'stream-json') ?? 'text', allow, mode, model: model?.ref, effort, sessionId });
    }

    const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder.root, timeout: 3000 }).then(
      (r) => r.stdout.trim(),
      () => null,
    );
    await updateConfig(p.config, (c) => ({ ...c, tipIndex: c.tipIndex + 1 }));
    const notice = import('./update/auto.ts').then(({ autoUpdate }) => autoUpdate(p, config)).catch(() => null);
    const { App } = await import('./tui/app.tsx');
    const screenReader = !!values['screen-reader'];
    // The fullscreen view: asked once (ATELIER_FULLSCREEN=1 or 0 decides without asking).
    const wantsFullscreen = (c: CliConfig) => (process.env.ATELIER_FULLSCREEN ? process.env.ATELIER_FULLSCREEN !== '0' : c.fullscreen);
    if (wantsFullscreen(config) === undefined && process.stdout.isTTY && !screenReader) {
      const { askFullscreen } = await import('./tui/fullscreen-ask.tsx');
      const answer = await askFullscreen(paint);
      if (answer !== null) config = await updateConfig(p.config, (c) => ({ ...c, fullscreen: answer }));
    }
    let openSession = sessionId;
    let firstPrompt = values.resume && !sessionId ? null : prompt || null;
    let ended: AppExit = { kind: 'quit' };
    // Once more after /fullscreen: the same session, in the other view.
    for (;;) {
      const fullscreen = !!wantsFullscreen(config) && !screenReader && !!process.stdout.isTTY;
      const mouse = fullscreen && config.mouse && !process.env.ATELIER_NO_MOUSE ? mouseInput(process.stdin) : null;
      let exit: AppExit = { kind: 'quit' };
      holdInput();
      const instance = render(
        createElement(App, {
          conn,
          paths: p,
          config,
          paint,
          folder,
          branch,
          models,
          model,
          initialSessionId: openSession,
          initialPrompt: firstPrompt,
          mode,
          notice,
          fullscreen,
          mouse: mouse?.mouse ?? null,
          onExit: (next: AppExit) => (exit = next),
        }),
        { exitOnCtrlC: false, interactive: interactive(), kittyKeyboard: { mode: 'auto' }, incrementalRendering: true, maxFps: 30, isScreenReaderEnabled: screenReader, alternateScreen: fullscreen, ...(mouse ? { stdin: mouse.stdin } : {}) },
      );
      if (mouse) {
        process.stdout.write(MOUSE_ON);
        process.once('exit', () => process.stdout.write(MOUSE_OFF));
      }
      setInstance(instance);
      await instance.waitUntilExit();
      setInstance(null);
      if (mouse) {
        process.stdout.write(MOUSE_OFF);
        mouse.close();
      }
      process.stdout.write(FOCUS_OFF);
      ended = exit as AppExit;
      if (ended.kind !== 'restart') break;
      openSession = ended.sessionId;
      firstPrompt = null;
      config = await readConfig(p.config);
    }
    conn.close();
    if (ended.kind === 'quit') {
      if (ended.keepRunning) process.stdout.write(`${paint.fg('muted', 'The reply goes on in the background. atelier -c picks this session up again.')}\n`);
      return 0;
    }
    if (ended.kind === 'logout') return logout(p, config);
    const next = await setup(p, config, ended.step, shade, 'session');
    // Back to the session that was open (`/provider`), else a new start as before.
    if (ended.step === 'providers') return main(ended.sessionId ? ['--session', ended.sessionId] : []);
    return next ? main(argv) : 0;
  } finally {
    conn.close();
  }
}

async function setup(p: ReturnType<typeof cliPaths>, config: CliConfig, start: 'all' | 'login' | 'connect' | 'providers', shade: Shade, afterwards: 'session' | 'exit' = 'exit'): Promise<CliConfig | null> {
  if (!process.stdin.isTTY) {
    process.stderr.write('Setup needs a terminal to ask in. Run atelier setup in one.\n');
    return null;
  }
  const { runSetup } = await import('./wizard/wizard.tsx');
  return runSetup(p, config, start, shade, afterwards);
}

async function logout(p: ReturnType<typeof cliPaths>, config: CliConfig): Promise<number> {
  if (config.connection?.mode !== 'server') {
    process.stdout.write('This terminal works on this computer: there is no sign-in to end.\n');
    return 0;
  }
  const url = config.connection.serverUrl;
  const store = await credentialStore(p.credentials);
  const token = await store.get(tokenName(url));
  if (token) {
    // Ends the sign-in on the server too, then forgets it here and stops lending this computer.
    const { contract, createRpcClient } = await import('@atelier/protocol');
    const { wsTransport } = await import('@atelier/client');
    const transport = wsTransport({ serverUrl: url, headers: () => ({ Authorization: `Bearer ${token}` }) });
    await createRpcClient(contract, transport)
      .call('auth.logout', {})
      .catch(() => undefined);
    transport.close();
  }
  await store.delete(tokenName(url));
  const link = await connectService(p, { mode: 'server', serverUrl: url }, { start: false }).catch(() => null);
  if (link) await stopService(link, true);
  process.stdout.write(`Signed out of ${new URL(url).host}.\n`);
  return 0;
}

/**
 * `atelier reset-keys`: starts the standalone backend's key store over when its key is gone for good (a keychain item
 * deleted, credentials.json lost). The API keys saved with the old key can't be read by anyone; they are added again
 * with /provider. Stops the background service first, which holds the key.
 */
async function resetKeys(p: ReturnType<typeof cliPaths>, config: CliConfig, force: boolean): Promise<number> {
  const { LOCAL_KEY } = await import('./keychain.ts');
  const { rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const link = await connectService(p, { mode: 'local' }, { start: false }).catch(() => null);
  if (link && !(await stopService(link, force))) {
    process.stderr.write('A reply is still running on this computer. Let it finish, or: atelier reset-keys --force\n');
    return 1;
  }
  await (await credentialStore(p.credentials)).delete(LOCAL_KEY);
  await rm(join(p.backendData, 'local-key.check'), { force: true });
  process.stdout.write(`Started the key store over. API keys saved before can't be read any more: add them again with /provider${config.connection?.mode === 'server' ? ' (this applies to this computer only, not your server)' : ''}.\n`);
  return 0;
}

async function daemonCommand(rest: string[], values: Record<string, unknown>, p: ReturnType<typeof cliPaths>, config: CliConfig): Promise<number> {
  const sub = rest[0];
  if (sub === 'run') {
    const { runDaemon } = await import('./daemon/daemon.ts');
    try {
      await runDaemon({ want: typeof values.server === 'string' ? { mode: 'server', serverUrl: values.server } : { mode: 'local' }, paths: p });
    } catch (e) {
      // The service runs without a terminal: what stopped it goes where the terminal that started it reads (daemon.error)
      // and into its log, instead of a stderr nobody sees.
      const { appendFile, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const message = e instanceof Error ? e.message : String(e);
      await appendFile(join(p.logs, 'daemon.log'), `${new Date().toISOString()} error not starting: ${e instanceof Error ? (e.stack ?? message) : message}\n`).catch(() => undefined);
      await writeFile(join(p.run, 'daemon.error'), message).catch(() => undefined);
      process.exit(1);
    }
    return new Promise(() => undefined);
  }
  const want = config.connection?.mode === 'server' ? { mode: 'server' as const, serverUrl: config.connection.serverUrl } : { mode: 'local' as const };
  if (sub === 'keep' || sub === 'unkeep') {
    const { keepService, unkeepService } = await import('./commands/service.ts');
    await updateConfig(p.config, (c) => ({ ...c, keepAvailable: sub === 'keep' }));
    process.stdout.write(`${sub === 'keep' ? await keepService(want) : await unkeepService()}\n`);
    return 0;
  }
  const link = await connectService(p, want, { start: false }).catch(() => null);
  if (!link) {
    process.stdout.write('The background service isn’t running.\n');
    return 0;
  }
  if (sub === 'stop') {
    const stopped = await stopService(link, !!values.force);
    process.stdout.write(stopped ? 'Stopped the background service.\n' : `A reply is still running in it. atelier daemon stop --force stops it anyway.\n`);
    return stopped ? 0 : 1;
  }
  const s = link.status;
  process.stdout.write(`Background service ${s.version}, process ${s.pid}, since ${new Date(s.startedAt).toLocaleString()}\n  ${s.want.mode === 'server' ? `lends this computer to ${s.want.serverUrl} (link ${s.link ?? 'off'})` : 'runs the backend for this computer'}\n  ${s.clients} ${s.clients === 1 ? 'client' : 'clients'}, ${s.busy} ${s.busy === 1 ? 'reply' : 'replies'} running${s.keepAvailable ? ', kept running at login' : ''}\n`);
  link.close();
  return 0;
}

async function listCommand(command: 'status' | 'models' | 'sessions', p: ReturnType<typeof cliPaths>, config: CliConfig, paint: Paint): Promise<number> {
  let conn: Connected;
  try {
    conn = await connect(p, config, { service: command === 'status' });
  } catch (e) {
    process.stderr.write(`${describe(e)}\n`);
    return e instanceof NeedsSetup ? 3 : 1;
  }
  try {
    if (command === 'models') {
      const models = await conn.rpc.call('models.list', {});
      for (const m of models.filter((x) => !x.hidden)) process.stdout.write(`${paint.fg('accent', m.ref.padEnd(44))} ${m.displayName}${m.personal ? paint.fg('muted', ' (yours)') : ''}\n`);
    } else if (command === 'sessions') {
      const list = await conn.rpc.call('sessions.list', { mode: 'code', limit: 50 });
      for (const s of list) process.stdout.write(`${paint.fg('muted', s.id)}  ${s.title || 'Untitled'}${s.status === 'running' ? paint.fg('accent', '  running') : ''}\n`);
    } else {
      const info = await conn.rpc.call('app.info', {});
      process.stdout.write(`${drawPip('base', paint.p.depth).join('\n')}\nAtelier CLI ${VERSION}\n${conn.mode === 'server' ? `Server ${conn.serverUrl} (Atelier ${info.version})` : `This computer (${p.backendData})`}\nSigned in as ${conn.user.name} (${conn.user.username})\n`);
    }
    return 0;
  } finally {
    conn.close();
  }
}

async function updateCommand(config: CliConfig, p: ReturnType<typeof cliPaths>, beta: boolean, paint: Paint): Promise<number> {
  const { updateNow, updateWords } = await import('./update/auto.ts');
  const result = await updateNow(p, config, { install: true, ...(beta ? { channel: 'beta' } : {}), onProgress: (t) => process.stdout.write(`${paint.fg('muted', t)}\n`) });
  process.stdout.write(`${updateWords(result, beta)}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0 || process.env.ATELIER_DAEMON !== '1') setTimeout(() => process.exit(code), 50).unref();
  },
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (process.env.ATELIER_DEBUG ? e.stack : e.message) : String(e)}\n`);
    process.exit(1);
  },
);
