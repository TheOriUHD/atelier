/**
 * `atelier daemon keep`: start the background service at login, so a server can work in this computer's folders while
 * no terminal is open (a session started in the browser, on a phone). macOS launchd, systemd's user manager on Linux,
 * a Task Scheduler entry at logon on Windows. `unkeep` takes it away.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Want } from '../daemon/wire.ts';
import { selfCommand } from '../runtime.ts';

const run = promisify(execFile);
const LABEL = 'dev.atelier.cli';

const quoteXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function keepService(want: Want): Promise<string> {
  const { command, args } = selfCommand();
  const full = [command, ...args, 'daemon', 'run', ...(want.mode === 'server' ? ['--server', want.serverUrl] : ['--local'])];
  if (process.platform === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${full.map((a) => `<string>${quoteXml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`,
    );
    await run('launchctl', ['unload', file]).catch(() => undefined);
    await run('launchctl', ['load', '-w', file]);
    return `It starts at login now (${file}).`;
  }
  if (process.platform === 'linux') {
    const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'atelier-cli.service');
    await writeFile(file, `[Unit]\nDescription=Atelier CLI background service\n\n[Service]\nExecStart=${full.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`);
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', 'atelier-cli.service']);
    return `It starts at login now (${file}). For it to run while you are logged out too: loginctl enable-linger ${process.env.USER ?? ''}`;
  }
  const line = full.map((a) => `"${a}"`).join(' ');
  await run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'Atelier CLI', '/TR', line, '/RL', 'LIMITED']);
  return 'It starts at logon now (Task Scheduler, “Atelier CLI”).';
}

export async function unkeepService(): Promise<string> {
  if (process.platform === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    await run('launchctl', ['unload', '-w', file]).catch(() => undefined);
    await rm(file, { force: true });
  } else if (process.platform === 'linux') {
    await run('systemctl', ['--user', 'disable', '--now', 'atelier-cli.service']).catch(() => undefined);
    await rm(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', 'atelier-cli.service'), { force: true });
  } else await run('schtasks', ['/Delete', '/F', '/TN', 'Atelier CLI']).catch(() => undefined);
  return 'It no longer starts at login.';
}
