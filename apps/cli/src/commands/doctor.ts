/** `atelier doctor` and `/doctor`: what works and what doesn't, with what to do. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig } from '../config.ts';
import { connectService } from '../daemon/client.ts';
import { credentialStore, tokenName } from '../keychain.ts';
import type { CliPaths } from '../paths.ts';
import { runnerDir, VERSION } from '../runtime.ts';
import { colorDepth, type Paint } from '../style.ts';
import { terminalName } from './terminal-setup.ts';

const run = promisify(execFile);

export async function runChecks(paths: CliPaths, paint: Paint): Promise<string[]> {
  const ok = (text: string) => `${paint.fg('good', '✓')} ${text}`;
  const warn = (text: string, fix: string) => `${paint.fg('warn', '!')} ${text}\n    ${paint.fg('muted', fix)}`;
  const bad = (text: string, fix: string) => `${paint.fg('bad', '✗')} ${text}\n    ${paint.fg('muted', fix)}`;
  const lines = [paint.bold(`Atelier CLI ${VERSION}`), ok(`Node ${process.versions.node} on ${process.platform} ${process.arch}`)];
  const runners = runnerDir();
  lines.push(runners ? ok(`Runner build in ${runners}`) : bad('No runner build for this computer', 'Reinstall: curl -fsSL https://updates.atelierhq.dev/cli | sh'));
  const git = await run('git', ['--version']).then((r) => r.stdout.trim(), () => null);
  lines.push(git ? ok(git) : warn('git isn’t installed', 'Folders work without it, but rewinding and diffs need it.'));
  const config = await readConfig(paths.config);
  const store = await credentialStore(paths.credentials);
  lines.push(ok(`Secrets kept in ${store.kind === 'keychain' ? 'the macOS keychain' : store.kind === 'secret-service' ? 'the Secret Service' : store.kind === 'dpapi' ? 'Windows’ DPAPI' : `${paths.credentials} (this user only)`}`));
  if (!config.connection) lines.push(warn('Not set up yet', 'Run atelier setup.'));
  else if (config.connection.mode === 'local') lines.push(ok(`Runs on this computer (${paths.backendData})`));
  else {
    const url = config.connection.serverUrl;
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) }).then(
      (r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null),
      () => null,
    );
    lines.push(health ? ok(`Server ${url} answers (Atelier ${health.version ?? '?'})`) : bad(`Server ${url} doesn’t answer`, 'Check the address and that it runs; atelier connect changes it.'));
    const token = await store.get(tokenName(url));
    if (!token) lines.push(bad('Not signed in to it', 'Run atelier login.'));
    else {
      // The update mirror answers 401 only to a sign-in it doesn't know.
      const status = await fetch(`${url}/updates/stable/atelier-cli.json`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).then((r) => r.status, () => 0);
      lines.push(status === 401 ? bad('The sign-in ended', 'Run atelier login.') : status ? ok('Signed in') : warn('Couldn’t check the sign-in', 'atelier login signs in again.'));
    }
  }
  if (config.connection) {
    const link = await connectService(paths, config.connection.mode === 'local' ? { mode: 'local' } : { mode: 'server', serverUrl: config.connection.serverUrl }, { start: false }).catch(() => null);
    if (link) {
      lines.push(ok(`Background service running (version ${link.status.version}, ${link.status.clients} ${link.status.clients === 1 ? 'client' : 'clients'}${link.status.link ? `, link ${link.status.link}` : ''})`));
      if (link.status.link === 'signed_out') lines.push(bad('The server turned this computer’s sign-in down', 'Run atelier login.'));
      link.close();
    } else lines.push(ok('Background service not running (it starts with the next session)'));
  }
  const depth = colorDepth();
  lines.push(ok(`Colours: ${['none', '16', '256', 'millions'][depth]}`));
  const t = terminalName();
  lines.push(t.shiftEnter === 'none' ? warn(`${t.label} can’t send Shift+Enter`, 'Alt+Enter or Ctrl+J make a new line.') : t.shiftEnter === 'setup' ? warn(`Shift+Enter needs a setting in ${t.label}`, 'Run /terminal-setup (or atelier setup).') : ok(`Shift+Enter works in ${t.label}`));
  return lines;
}
