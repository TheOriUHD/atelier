#!/usr/bin/env node
// Builds the computer use helpers this machine can build, into native/bin (`pnpm computer:build`):
//   - atelier-computer-darwin: the Swift helper (native/computer-macos/build.sh), on macOS only;
//   - atelier-computer-windows-x64.exe and -arm64.exe: the Go helper (native/computer-windows), cross-compiled
//     wherever `go` is on PATH.
// It says what it built and what it skipped; a build that fails fails the script.
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const native = dirname(fileURLToPath(import.meta.url));
const root = join(native, '..');
const bin = join(native, 'bin');
mkdirSync(bin, { recursive: true });

const built = [];
const skipped = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    console.error(
      `computer:build: ${command} ${args.join(' ')} failed: ${result.error?.message ?? `exit ${result.status}`}`,
    );
    process.exit(1);
  }
}

function has(command) {
  const probe = spawnSync(command, ['version'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

const size = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;

// macOS: the Swift helper.
if (process.platform === 'darwin') {
  run('sh', [join(native, 'computer-macos', 'build.sh')]);
  built.push(join(bin, 'atelier-computer-darwin'));
} else {
  skipped.push('atelier-computer-darwin: the macOS helper builds on macOS only');
}

// Anywhere with Go: the Windows helper, both architectures. A GUI-subsystem exe (-H windowsgui), so Electron starting it
// opens no console window; its stdio are the pipes main gives it.
if (has('go')) {
  const source = join(native, 'computer-windows');
  for (const [goarch, name] of [
    ['amd64', 'atelier-computer-windows-x64.exe'],
    ['arm64', 'atelier-computer-windows-arm64.exe'],
  ]) {
    const out = join(bin, name);
    run('go', ['build', '-trimpath', '-ldflags', '-s -w -H windowsgui', '-o', out, '.'], {
      cwd: source,
      env: { ...process.env, GOOS: 'windows', GOARCH: goarch, CGO_ENABLED: '0' },
    });
    built.push(out);
  }
} else {
  skipped.push('atelier-computer-windows-*.exe: `go` is not on PATH');
}

for (const file of built) console.log(`built   ${relative(root, file)} (${size(file)})`);
for (const why of skipped) console.log(`skipped ${why}`);
