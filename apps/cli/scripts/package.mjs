// Packages the terminal app for the six platforms (ARCHITECTURE §25). Each package is a folder:
//   bin/atelier (bin/atelier.cmd)   the command: runs the bundle with the Node beside it
//   node/                           the official Node.js build for that platform (its binary and license)
//   lib/atelier.mjs, LICENSES.txt   the bundle (pnpm --filter @atelier/cli build)
//   lib/runner/                     the runner for this platform, plus the Linux and macOS ones for SSH hosts
// packed as atelier-cli-<version>-<platform>.tar.gz (a .zip for Windows), and atelier-cli.json lists them with
// their sha512 and size (the update check reads it; the release signs each package). Node comes from nodejs.org,
// checked against its SHASUMS256.txt, and is kept in a cache between releases.
//
//   node apps/cli/scripts/package.mjs --version 0.6.0 --runners runner/bin --out <dir> [--only darwin-arm64]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_VERSION = '24.22.2';
export const TARGETS = [
  { key: 'darwin-arm64', node: 'darwin-arm64', runner: 'darwin-arm64' },
  { key: 'darwin-x64', node: 'darwin-x64', runner: 'darwin-amd64' },
  { key: 'linux-x64', node: 'linux-x64', runner: 'linux-amd64' },
  { key: 'linux-arm64', node: 'linux-arm64', runner: 'linux-arm64' },
  { key: 'windows-x64', node: 'win-x64', runner: 'windows-amd64' },
  { key: 'windows-arm64', node: 'win-arm64', runner: 'windows-arm64' },
];
/** The runner builds every package carries for SSH hosts. */
const SSH_RUNNERS = ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const POSIX_LAUNCHER = `#!/bin/sh
# Atelier CLI: runs the bundle with the Node.js beside it. Follows the link in ~/.local/bin to this install.
self="$0"
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
dir=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$dir/node/bin/node" "$dir/lib/atelier.mjs" "$@"
`;
const WINDOWS_LAUNCHER = '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\lib\\atelier.mjs" %*\r\n';

async function nodeFor(target, cache) {
  const ext = target.node.startsWith('win') ? 'zip' : 'tar.gz';
  const name = `node-v${NODE_VERSION}-${target.node}.${ext}`;
  const file = join(cache, name);
  const sumsFile = join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(sumsFile)) {
    const res = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`);
    if (!res.ok) throw new Error(`nodejs.org answered ${res.status} for SHASUMS256.txt`);
    writeFileSync(sumsFile, await res.text());
  }
  const want = readFileSync(sumsFile, 'utf8')
    .split('\n')
    .find((l) => l.endsWith(`  ${name}`))
    ?.split(/\s+/)[0];
  if (!want) throw new Error(`SHASUMS256.txt has no ${name}`);
  const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (!existsSync(file) || sha(file) !== want) {
    const res = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}`);
    if (!res.ok) throw new Error(`nodejs.org answered ${res.status} for ${name}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    if (sha(file) !== want) throw new Error(`${name} doesn't match its checksum`);
  }
  // Unpacked once per cache, then only the binary and its license are taken.
  const unpacked = join(cache, `node-v${NODE_VERSION}-${target.node}`);
  if (!existsSync(unpacked)) execFileSync(ext === 'zip' ? 'unzip' : 'tar', ext === 'zip' ? ['-q', file, '-d', cache] : ['-xzf', file, '-C', cache]);
  return unpacked;
}

const sha512 = (path) => createHash('sha512').update(readFileSync(path)).digest('base64');

async function main() {
  const version = arg('version');
  const runners = arg('runners', join(root, '../../runner/bin'));
  const out = arg('out', join(root, 'release'));
  const only = arg('only');
  const cache = arg('cache', join(homedir(), '.atelier-release', 'node'));
  if (!version) throw new Error('usage: node apps/cli/scripts/package.mjs --version <v> [--runners dir] [--out dir] [--only key]');
  const bundle = join(root, 'dist', 'atelier.mjs');
  if (!existsSync(bundle)) throw new Error('Build the bundle first: pnpm --filter @atelier/cli build');
  mkdirSync(out, { recursive: true });
  const files = {};
  const work = join(tmpdir(), `atelier-cli-package-${process.pid}`);
  for (const target of TARGETS.filter((t) => !only || t.key === only)) {
    const name = `atelier-cli-${version}-${target.key}`;
    const dir = join(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'lib', 'runner'), { recursive: true });
    mkdirSync(join(dir, 'node'), { recursive: true });
    const windows = target.key.startsWith('windows');
    // The command.
    if (windows) writeFileSync(join(dir, 'bin', 'atelier.cmd'), WINDOWS_LAUNCHER);
    else {
      writeFileSync(join(dir, 'bin', 'atelier'), POSIX_LAUNCHER);
      chmodSync(join(dir, 'bin', 'atelier'), 0o755);
    }
    // Node.
    const node = await nodeFor(target, cache);
    if (windows) copyFileSync(join(node, 'node.exe'), join(dir, 'node', 'node.exe'));
    else {
      mkdirSync(join(dir, 'node', 'bin'), { recursive: true });
      copyFileSync(join(node, 'bin', 'node'), join(dir, 'node', 'bin', 'node'));
      chmodSync(join(dir, 'node', 'bin', 'node'), 0o755);
    }
    copyFileSync(join(node, 'LICENSE'), join(dir, 'node', 'LICENSE'));
    // The bundle and its licenses.
    copyFileSync(bundle, join(dir, 'lib', 'atelier.mjs'));
    copyFileSync(join(root, 'dist', 'LICENSES.txt'), join(dir, 'lib', 'LICENSES.txt'));
    // Runners: this platform's, and the ones SSH hosts get.
    const checksums = JSON.parse(readFileSync(join(runners, 'checksums.json'), 'utf8'));
    const wanted = new Set([target.runner, ...SSH_RUNNERS]);
    const binaries = {};
    for (const [key, entry] of Object.entries(checksums.binaries)) {
      if (!wanted.has(key)) continue;
      cpSync(join(runners, entry.file), join(dir, 'lib', 'runner', entry.file));
      binaries[key] = entry;
    }
    if (!binaries[target.runner]) throw new Error(`No ${target.runner} runner in ${runners} (pnpm runner:build builds all six)`);
    writeFileSync(join(dir, 'lib', 'runner', 'checksums.json'), JSON.stringify({ ...checksums, binaries }, null, 2));
    // The package.
    const file = `${name}.${windows ? 'zip' : 'tar.gz'}`;
    const path = join(out, file);
    rmSync(path, { force: true });
    if (windows) execFileSync('zip', ['-qr', '-X', path, '.'], { cwd: dir });
    else execFileSync('tar', ['-czf', path, '-C', work, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    files[target.key] = { file, sha512: sha512(path), size: readFileSync(path).length };
    console.log(`${file} ${(files[target.key].size / 1048576).toFixed(1)} MB`);
  }
  rmSync(work, { recursive: true, force: true });
  if (!only) writeFileSync(join(out, 'atelier-cli.json'), `${JSON.stringify({ version, files }, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
