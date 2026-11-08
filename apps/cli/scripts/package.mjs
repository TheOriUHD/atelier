// Packages the terminal app for the six platforms (ARCHITECTURE §25). Each package is a folder:
//   bin/atelier (bin/atelier.cmd)   the command: runs the bundle with the Node beside it
//   node/                           the official Node.js build for that platform: its binary, named `atelier` on macOS and
//                                   Linux (so the system's prompts and process lists say Atelier), and its license
//   lib/atelier.mjs, LICENSES.txt   the bundle (pnpm --filter @atelier/cli build)
//   lib/runner/                     the runner for this platform, plus the Linux and macOS ones for SSH hosts
// packed as atelier-cli-<version>-<platform>.tar.gz (a .zip for Windows), and atelier-cli.json lists them with
// their sha512 and size (the update check reads it; the release signs each package). Node comes from nodejs.org,
// checked against its SHASUMS256.txt, and is kept in a cache between releases.
//
// On macOS, local network privacy asks each program before it reaches devices on the network (an Atelier server at
// home): in a terminal app other than Terminal, the program itself, by its code signature. Node.js's own build was a
// program called "node" with the UUID every copy of that release shares. So the macOS binary is branded first
// (macho.mjs: its own UUID, an embedded Info.plist as `dev.atelier.cli`, as Apple's TN3179 asks) and signed again as
// `dev.atelier.cli`: `--sign` with the Developer ID in the keychain, keeping only V8's two exceptions to the hardened
// runtime (JIT code; Node's own signature also allows debugging and loading unsigned libraries, which Atelier doesn't
// need), else ad hoc for a local build. macOS then asks once for "atelier", and the answer holds across updates.
// `--notarize` then has Apple notarize them (notarytool, the keychain profile `atelier-notary` or
// APPLE_KEYCHAIN_PROFILE). Branding needs codesign, so it only happens on a Mac.
//
//   node apps/cli/scripts/package.mjs --version 0.6.0 --runners runner/bin --out <dir> [--only darwin-arm64] [--sign] [--notarize]
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandMachO, cliInfoPlist, uuidFor } from './macho.mjs';

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

const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
`;

/** The Developer ID to sign with: ATELIER_CLI_SIGN_IDENTITY, else the keychain's "Developer ID Application". */
function signingIdentity() {
  if (process.env.ATELIER_CLI_SIGN_IDENTITY) return process.env.ATELIER_CLI_SIGN_IDENTITY;
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const name = /"(Developer ID Application: .+? \([A-Z0-9]{10}\))"/.exec(identities)?.[1];
  if (!name) throw new Error('No "Developer ID Application" certificate in the keychain (see docs/updates.md).');
  return name;
}

/** Brands the macOS Node as Atelier CLI (see the top) and signs it: with the Developer ID, or ad hoc without one. */
function brandMac(binary, { version, target, identity, entitlements }) {
  const uuid = uuidFor('dev.atelier.cli', version, target.key, NODE_VERSION);
  writeFileSync(binary, brandMachO(readFileSync(binary), { plist: cliInfoPlist(version), uuid }));
  const how = identity ? ['--sign', identity, '--options', 'runtime', '--timestamp', '--entitlements', entitlements] : ['--sign', '-'];
  execFileSync('codesign', ['--force', ...how, '--identifier', 'dev.atelier.cli', binary], { stdio: 'pipe' });
  execFileSync('codesign', ['--verify', '--strict', binary], { stdio: 'pipe' });
  // `codesign -dv` reports on stderr.
  if (!/Info\.plist entries=\d+/.test(spawnSync('codesign', ['-dv', binary], { encoding: 'utf8' }).stderr)) throw new Error(`codesign didn't bind the Info.plist in ${binary}`);
}

const POSIX_LAUNCHER = `#!/bin/sh
# Atelier CLI: runs the bundle with the Node.js beside it. Follows the link in ~/.local/bin to this install.
self="$0"
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
dir=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$dir/node/bin/atelier" "$dir/lib/atelier.mjs" "$@"
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
  const sign = process.argv.includes('--sign');
  const notarize = process.argv.includes('--notarize');
  if ((sign || notarize) && process.platform !== 'darwin') throw new Error('--sign and --notarize run on a Mac.');
  const identity = sign ? signingIdentity() : null;
  const signed = [];
  if (!version) throw new Error('usage: node apps/cli/scripts/package.mjs --version <v> [--runners dir] [--out dir] [--only key]');
  const bundle = join(root, 'dist', 'atelier.mjs');
  if (!existsSync(bundle)) throw new Error('Build the bundle first: pnpm --filter @atelier/cli build');
  mkdirSync(out, { recursive: true });
  const files = {};
  const work = join(tmpdir(), `atelier-cli-package-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const entitlements = join(work, 'entitlements.plist');
  writeFileSync(entitlements, ENTITLEMENTS);
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
      const binary = join(dir, 'node', 'bin', 'atelier');
      copyFileSync(join(node, 'bin', 'node'), binary);
      chmodSync(binary, 0o755);
      if (target.key.startsWith('darwin') && process.platform !== 'darwin') console.warn(`${name}: not branded or signed (that needs a Mac)`);
      if (target.key.startsWith('darwin') && process.platform === 'darwin') brandMac(binary, { version, target, identity, entitlements });
      if (identity && target.key.startsWith('darwin')) {
        const kept = join(work, 'signed', target.key);
        mkdirSync(kept, { recursive: true });
        copyFileSync(binary, join(kept, 'atelier'));
        signed.push(kept);
      }
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
  if (notarize) {
    if (!signed.length) throw new Error('--notarize needs --sign and a macOS target.');
    const zip = join(work, 'atelier-cli-mac.zip');
    execFileSync('ditto', ['-c', '-k', '--keepParent', join(work, 'signed'), zip]);
    const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'atelier-notary';
    console.log('notarizing the macOS binaries …');
    const out = execFileSync('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--wait', '--output-format', 'json'], { encoding: 'utf8' });
    const status = JSON.parse(out).status;
    if (status !== 'Accepted') throw new Error(`Notarization said ${status}: xcrun notarytool log <id> --keychain-profile ${profile}`);
    console.log('notarized');
  }
  rmSync(work, { recursive: true, force: true });
  if (!only) writeFileSync(join(out, 'atelier-cli.json'), `${JSON.stringify({ version, files }, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
