#!/usr/bin/env node
/**
 * The release command: one command from a tested main branch to a published release (docs/updates.md, "Releasing").
 *
 *   pnpm release 0.1.11              check, test, version, tag, build everywhere, sign, ask, publish, verify
 *   pnpm release 0.1.11 --build-only everything up to a folder of signed files; publishes nothing
 *   pnpm release 0.1.11              run again after a failure: finished steps are skipped (~/.atelier-release/builds/<version>/state.json)
 *
 * Flags: --yes (publish without asking), --skip qa,e2e,linux,windows,mac,image,installer,docs (comma list), --trailer "<line>"
 * (added to the commits it makes). The browser and desktop end-to-end tests run on the Linux machine beside the builds.
 *
 * Where things are built (all settable with environment variables, see CONFIG below):
 *   Linux packages, the tests and the server image   a Linux machine over ssh (ATELIER_RELEASE_LINUX, default atelier-linux)
 *   the Windows installer                             a Windows machine over ssh (ATELIER_RELEASE_WINDOWS, default atelier-win)
 *   the macOS apps (signed, notarized)                this Mac, in a clean worktree of the tag, while the others build
 * The update-signing key and the Apple credentials never leave this Mac. Nothing leaves it either until you answer the
 * question before "publish": the git push, the GitHub release, the update feed, the website and the docs.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  changelogSection,
  checkRelease,
  compareVersions,
  cutChangelog,
  duration,
  expectedFiles,
  hasReleaseNotes,
  imageNames,
  isPackage,
  parseNotarizationStatus,
  parseUpdateFile,
  parseVersion,
  readAppVersion,
  releaseNotes,
  renderInstaller,
  repoFromRemote,
  setAppVersion,
  setPackageVersion,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const CONFIG = {
  linux: process.env.ATELIER_RELEASE_LINUX ?? 'atelier-linux',
  windows: process.env.ATELIER_RELEASE_WINDOWS ?? 'atelier-win',
  /** The Windows machine's build folder: tools\node, src\ and the files this command copies there. */
  windowsRoot: process.env.ATELIER_RELEASE_WINDOWS_ROOT ?? 'C:/atelier-build',
  feed: process.env.ATELIER_RELEASE_FEED ?? 'https://updates.atelierhq.dev',
  notaryTimeoutHours: Number(process.env.ATELIER_RELEASE_NOTARY_HOURS ?? 4),
  updateKey: process.env.ATELIER_UPDATE_KEY ?? join(homedir(), '.atelier-release', 'update-signing.key'),
  /** Where a release's checkout, logs, built files and state live: outside the repository, next to the signing key. */
  workDir: process.env.ATELIER_RELEASE_WORK ?? join(homedir(), '.atelier-release', 'builds'),
};
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30'];

// ---------------------------------------------------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const args = { yes: false, buildOnly: false, skip: new Set(), trailer: '', version: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') args.yes = true;
    else if (a === '--build-only') args.buildOnly = true;
    else if (a === '--skip') for (const s of (argv[++i] ?? '').split(',')) args.skip.add(s.trim());
    else if (a === '--trailer') args.trailer = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown flag ${a}. See the top of deploy/ship/release.mjs.`);
    else args.version = a;
  }
  return args;
}

// ---------------------------------------------------------------------------------------------------------------------
// Output, processes and state

const t0 = Date.now();
const clock = () => new Date().toLocaleTimeString('en-GB');
const say = (message) => console.log(`[${clock()}] ${message}`);
const timings = [];

/** Runs `fn` as a named step: says when it starts and ends, and remembers how long it took. */
async function step(name, fn) {
  const start = Date.now();
  say(`${name} …`);
  try {
    const result = await fn();
    timings.push([name, Date.now() - start]);
    say(`${name}: done (${duration(Date.now() - start)})`);
    return result;
  } catch (e) {
    say(`${name}: FAILED (${duration(Date.now() - start)})`);
    throw e;
  }
}

/** Runs a command, writing its output to a log file; resolves with the output, rejects (with the log's tail) on failure. */
function exec(cmd, args, { cwd = ROOT, env, input, log, check = true } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const sink = log ? createWriteStream(log, { flags: 'a' }) : null;
    sink?.write(`\n$ ${cmd} ${args.join(' ').slice(0, 400)}\n`);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        out.push(chunk);
        sink?.write(chunk);
      });
    }
    child.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      sink?.end();
      const text = Buffer.concat(out).toString('utf8');
      if (code !== 0 && check) {
        const tail = text.split('\n').filter(Boolean).slice(-15).join('\n');
        reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed (${code})${log ? `, log: ${log}` : ''}\n${tail}`));
      } else resolvePromise({ code, out: text });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const gitOk = (...args) => {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
};

function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { done: {} };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The run

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.version) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*\n|^ \* ?/gm, ''));
    process.exit(args.help ? 0 : 2);
  }
  const { version, tag, prerelease, channel } = parseVersion(args.version);
  const work = join(CONFIG.workDir, version);
  const logs = join(work, 'logs');
  const artifacts = join(work, 'artifacts');
  const publish = join(work, 'publish');
  const tree = join(work, 'tree');
  mkdirSync(logs, { recursive: true });
  const stateFile = join(work, 'state.json');
  const state = loadState(stateFile);
  const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const log = (name) => join(logs, `${name}.log`);
  const once = async (key, name, fn) => {
    if (state.done[key]) return say(`${name}: already done`);
    const result = await step(name, fn);
    state.done[key] = new Date().toISOString();
    save();
    return result;
  };
  const skipped = (what) => args.skip.has(what);
  const repo = repoFromRemote(git('remote', 'get-url', 'origin'));
  const trailer = args.trailer ? `\n\n${args.trailer}` : '';

  say(`Releasing Atelier ${version} (${channel}) from ${git('rev-parse', '--abbrev-ref', 'HEAD')} ${git('rev-parse', '--short', 'HEAD')}`);

  // 1. Checks that need nothing built ---------------------------------------------------------------------------------
  await step('checks', () => preflight({ version, tag, args, done: state.done }));

  // 2. Tests on the Linux machine, before anything is committed --------------------------------------------------------
  if (!state.done.tag && !skipped('qa')) {
    await once('qa', 'tests (typecheck, lint, unit)', () => runQa({ log: log('qa') }));
  }

  // 3. Version, changelog, commit, tag --------------------------------------------------------------------------------
  await once('tag', `version ${version}, changelog, commit and tag`, () => prepare({ version, tag, trailer }));
  state.sha ??= git('rev-parse', `${tag}^{commit}`);
  save();

  // 4. A clean checkout of the tag, and the runner binaries every platform bundles ------------------------------------
  await once('tree', 'clean checkout of the tag and the runners', () => makeTree({ tag, tree, work, log: log('tree') }));

  // 5. Builds, side by side -------------------------------------------------------------------------------------------
  const builds = [
    ['installer', () => buildInstaller({ version, tree, work, log: log('installer') })],
    ['linux', () => buildLinux({ tag, version, work, artifacts, log: log('linux'), skipImage: skipped('image'), skipE2e: skipped('e2e'), imageBase: imageNames(repo, tag, prerelease).base })],
    ['windows', () => buildWindows({ tag, version, work, artifacts, log: log('windows') })],
    ['mac', () => buildMac({ version, tree, artifacts, log: log('mac') })],
  ].filter(([name]) => !skipped(name));
  const results = await Promise.allSettled(
    builds.map(([name, fn]) =>
      once(`build:${name}`, `build ${name}`, fn).catch((e) => {
        say(`${name} failed: ${e.message.split('\n')[0]}`);
        throw e;
      }),
    ),
  );
  const failed = results.map((r, i) => (r.status === 'rejected' ? `${builds[i][0]}: ${r.reason.message}` : null)).filter(Boolean);
  if (failed.length) throw new Error(`Not everything built. Fix it and run the same command again: finished steps are kept.\n\n${failed.join('\n\n')}`);

  // 6. One folder with everything, checked, with signatures -----------------------------------------------------------
  const platforms = ['linux', 'windows', 'mac'].filter((p) => !skipped(p));
  const installerFiles = skipped('installer') ? null : join(work, 'installer');
  await once('assemble', 'collect, check and sign the files', () => assemble({ version, platforms, artifacts, publish, log: log('sign') }));
  const notes = releaseNotes(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);

  if (args.buildOnly) {
    say(`Built and checked. The files are in ${publish}. Nothing was published (--build-only).`);
    return summary(work);
  }

  // 7. The question ---------------------------------------------------------------------------------------------------
  if (git('rev-parse', 'HEAD') !== state.sha && !state.done.pushed) {
    throw new Error(`HEAD is ${git('rev-parse', '--short', 'HEAD')} but ${tag} was built from ${state.sha.slice(0, 7)}. Publishing would push the commits in between. Move them aside (or release from the tag's commit) and run again.`);
  }
  const imageReady = !skipped('image') && (await ghcrLogin());
  await confirm({ version, tag, channel, repo, publish, args, imageReady, skipped });

  // 8. Publish --------------------------------------------------------------------------------------------------------
  if (imageReady) await once('image', 'push the server images (before the feed: servers update from it)', () => pushImages({ tag, repo, prerelease, log: log('image-push') }));
  await once('pushed', 'push main and the tag', async () => {
    await exec('git', ['push', 'origin', 'main', tag], { log: log('push') });
  });
  const notesFile = join(work, 'notes.md');
  writeFileSync(notesFile, `${notes}\n`);
  if (installerFiles) {
    await once('worker', 'update-feed worker (only when its code changed)', () => deployWorker({ tag, log: log('worker') }));
  }
  await Promise.all([
    ...(installerFiles ? [once('installer-publish', 'server installer (atelier-setup and install script)', () => publishInstaller({ version, prerelease, dir: installerFiles, log: log('installer-publish') }))] : []),
    once('github', 'GitHub release', () => githubRelease({ tag, version, repo, prerelease, publish, notesFile, extra: installerFiles ? [join(installerFiles, 'install.sh')] : [], log: log('github') })),
    once('feed', `update feed (${channel})`, () => exec('node', ['deploy/cloudflare/publish.mjs', publish, channel], { log: log('feed') })),
  ]);
  if (!prerelease) {
    await once('site', 'website download list and deploy', () => deploySite({ tag, version, trailer, log: log('site') }));
    if (!skipped('docs')) await once('docs', 'documentation deploy', () => deployDocs({ log: log('docs') }));
  }

  // 9. Look at what is live --------------------------------------------------------------------------------------------
  const problems = await step('verify what is live', () => verifyLive({ version, tag, channel, repo, publish, installerFiles }));
  summary(work, problems, { repo, tag, channel, version, prerelease });
  if (problems.length) process.exitCode = 1;
  else {
    // The clean checkout has done its job; the logs, the built files and the state stay.
    await exec('git', ['worktree', 'remove', '--force', tree], { check: false });
    rmSync(join(work, 'src.tar.gz'), { force: true });
  }
}

function summary(work, problems = [], info) {
  console.log('');
  for (const [name, ms] of timings) console.log(`  ${duration(ms).padStart(8)}  ${name}`);
  console.log(`  ${duration(Date.now() - t0).padStart(8)}  total`);
  if (problems.length) {
    console.log('\nProblems found on what is live:');
    for (const p of problems) console.log(`  - ${p}`);
  } else if (info) {
    console.log(`\nAtelier ${info.version} is out: https://github.com/${info.repo}/releases/tag/${info.tag}`);
    console.log(
      [
        'Still yours: anything the changelog says needs doing on a server (the compose file, the sandbox image, pulling the',
        'new images where the images were pushed).',
      ].join('\n'),
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks

async function preflight({ version, tag, args, done = {} }) {
  const problems = [];
  const need = (ok, message) => ok || problems.push(message);
  const major = Number(process.versions.node.split('.')[0]);
  need(major >= 24, `Node ${process.versions.node} is too old: the repository needs 24 or newer.`);
  const tagExists = gitOk('rev-parse', '--verify', '--quiet', `refs/tags/${tag}`);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  need(branch === 'main', `You are on "${branch}"; releases are made from main.`);
  if (!tagExists) {
    need(git('status', '--porcelain', '--untracked-files=no') === '', 'There are uncommitted changes to tracked files. Commit or stash them: the release commit must be exactly what you meant to ship.');
    const latest = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').find((t) => /^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(t));
    if (latest) need(compareVersions(version, latest.slice(1)) > 0, `${version} is not newer than the latest tag, ${latest}.`);
    const remote = await exec('git', ['fetch', 'origin', 'main', '--quiet'], { check: false });
    if (remote.code === 0) {
      const behind = Number(git('rev-list', '--count', 'HEAD..origin/main'));
      need(behind === 0, `main is ${behind} commit(s) behind origin/main. Pull first.`);
    }
    const app = readFileSync(join(ROOT, 'packages/protocol/src/app.ts'), 'utf8');
    need(readAppVersion(app) !== null, "APP.version isn't readable in packages/protocol/src/app.ts.");
    if (!isPrereleaseVersion(version)) {
      const notes = readFileSync(join(ROOT, 'packages/ui/src/features/whats-new/release-notes.ts'), 'utf8');
      need(hasReleaseNotes(notes, version), `No "What's new" notes for ${version}: add them to packages/ui/src/features/whats-new/release-notes.ts first.`);
    }
    const notices = await exec('node', [join(ROOT, 'deploy/ship/notices.mjs'), '--check'], { check: false });
    need(notices.code === 0, 'The third-party notices are out of date: run pnpm notices and commit the result.');
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    try {
      if (isPrereleaseVersion(version)) {
        if (!changelogSection(changelog, 'Unreleased')) throw new Error('"## [Unreleased]" in CHANGELOG.md is empty: a prerelease has nothing to show.');
      } else cutChangelog(changelog, version, '2000-01-01');
    } catch (e) {
      problems.push(e.message);
    }
  }
  // Machines and tools every release needs.
  const skip = (what) => args.skip.has(what);
  // A machine whose part is done (a re-run after a failure elsewhere) needn't answer: Linux has the tests, its build and
  // the image push, Windows only its build.
  const finished = { linux: !!(done.tag && done['build:linux'] && done.image), windows: !!done['build:windows'] };
  for (const [name, host] of [['linux', CONFIG.linux], ['windows', CONFIG.windows]]) {
    if (skip(name) && !(name === 'linux' && !skip('qa'))) continue;
    if (finished[name]) continue;
    const r = await exec('ssh', [...SSH, host, 'echo ok'], { check: false });
    need(r.code === 0 && r.out.includes('ok'), `Can't log in to the ${name} build machine "${host}" over ssh.`);
  }
  if (!skip('mac')) {
    const ids = (await exec('security', ['find-identity', '-v', '-p', 'codesigning'], { check: false })).out;
    need(/Developer ID Application/.test(ids), 'No "Developer ID Application" certificate in the keychain: the macOS apps cannot be signed.');
    const notary = await exec('xcrun', ['notarytool', 'history', '--keychain-profile', process.env.APPLE_KEYCHAIN_PROFILE ?? 'atelier-notary'], { check: false });
    need(notary.code === 0, 'The notarization login "atelier-notary" does not work (docs/updates.md, "Signing the macOS build").');
  }
  if (!skip('installer')) {
    const go = await exec('go', ['version'], { check: false, env: { PATH: `${process.env.PATH}:/usr/local/go/bin:/opt/homebrew/bin` } });
    need(go.code === 0, 'Go is not installed on this Mac: the server installer (atelier-setup) is built here.');
  }
  if (!args.buildOnly) {
    need((await exec('gh', ['auth', 'status'], { check: false })).code === 0, 'The GitHub CLI is not signed in (gh auth login).');
    need(existsSync(CONFIG.updateKey), `No update-signing key at ${CONFIG.updateKey}.`);
    need((await exec('npx', ['--yes', 'wrangler@4', 'whoami'], { check: false })).out.includes('You are logged in'), 'wrangler is not logged in to Cloudflare (npx wrangler login).');
  }
  if (problems.length) throw new Error(`Not ready:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}
const isPrereleaseVersion = (version) => version.includes('-');

// ---------------------------------------------------------------------------------------------------------------------
// Tests, on the Linux machine

/** The Linux machine's copy of the tree, uploaded as a tarball and unpacked fresh. */
async function uploadTree({ host, ref, name, tarball, log, runnerTar }) {
  // The tag's tarball is made once (makeTree) and shared by the machines; a tarball of HEAD is made for the tests.
  if (ref) await exec('git', ['archive', '--format=tar.gz', '-o', tarball, ref], { log });
  await exec('scp', ['-q', ...SSH, tarball, `${host}:builds/${name}.tar.gz`], { log });
  if (runnerTar) await exec('scp', ['-q', ...SSH, runnerTar, `${host}:builds/${name}-runner.tar.gz`], { log });
  const unpack = [
    'set -e',
    `rm -rf ~/builds/${name} && mkdir -p ~/builds/${name}`,
    `tar -xzf ~/builds/${name}.tar.gz -C ~/builds/${name}`,
    runnerTar ? `mkdir -p ~/builds/${name}/runner && tar -xzf ~/builds/${name}-runner.tar.gz -C ~/builds/${name}/runner` : 'true',
    // Keep the three newest trees and tarballs.
    'cd ~/builds && ls -dt */ 2>/dev/null | tail -n +5 | xargs -r rm -rf; ls -t *.tar.gz 2>/dev/null | tail -n +7 | xargs -r rm -f',
  ].join('; ');
  await exec('ssh', [...SSH, host, unpack], { log });
}

async function runQa({ log }) {
  const name = `qa-${git('rev-parse', '--short', 'HEAD')}`;
  const tarball = join(tmpDir(), `${name}.tar.gz`);
  await exec('ssh', [...SSH, CONFIG.linux, 'mkdir -p ~/builds'], { log });
  await uploadTree({ host: CONFIG.linux, ref: 'HEAD', name, tarball, log });
  const script = [
    'set -uo pipefail',
    'export PATH=/usr/local/go/bin:$PATH CI=1',
    `cd ~/builds/${name}`,
    'pnpm install --frozen-lockfile >/dev/null 2>&1 || { echo "pnpm install failed"; exit 1; }',
    'pnpm runner:build >/dev/null 2>&1 || { echo "runner build failed"; exit 1; }',
    // The three checks side by side; each writes its own log, and the first line of each says how it went.
    '(pnpm typecheck > typecheck.log 2>&1; echo $? > typecheck.code) &',
    '(pnpm lint > lint.log 2>&1; echo $? > lint.code) &',
    '(pnpm setup:test > setup.log 2>&1; echo $? > setup.code) &',
    // One retry per failing test: a few of them time real seconds, and 24 cores running them at once can miss a window.
    '(pnpm test --retry=1 > unit.log 2>&1; echo $? > unit.code) &',
    'wait',
    'bad=0; for c in typecheck lint setup unit; do if [ "$(cat $c.code)" != 0 ]; then echo "--- $c failed"; tail -40 $c.log; bad=1; else echo "$c ok: $(grep -E "Tests .*passed" $c.log | tail -1)"; fi; done',
    'exit $bad',
  ].join('\n');
  const r = await exec('ssh', [...SSH, CONFIG.linux, 'bash -s'], { input: script, log, check: false });
  if (r.code !== 0) throw new Error(`The checks failed on the Linux machine:\n${r.out.split('\n').slice(-45).join('\n')}`);
}

function tmpDir() {
  const dir = join(CONFIG.workDir, '_tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------------
// Version, changelog, commit, tag

function prepare({ version, tag, trailer }) {
  if (gitOk('rev-parse', '--verify', '--quiet', `refs/tags/${tag}`)) {
    say(`${tag} already exists: building from it`);
    return git('rev-parse', `${tag}^{commit}`);
  }
  const files = {
    app: join(ROOT, 'packages/protocol/src/app.ts'),
    pkg: join(ROOT, 'apps/desktop/package.json'),
    changelog: join(ROOT, 'CHANGELOG.md'),
  };
  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  writeFileSync(files.app, setAppVersion(readFileSync(files.app, 'utf8'), version));
  writeFileSync(files.pkg, setPackageVersion(readFileSync(files.pkg, 'utf8'), version));
  // A prerelease leaves the changelog as it is: its changes are still the next release's.
  if (!isPrereleaseVersion(version)) writeFileSync(files.changelog, cutChangelog(readFileSync(files.changelog, 'utf8'), version, today));
  git('add', files.app, files.pkg, ...(isPrereleaseVersion(version) ? [] : [files.changelog]));
  git('commit', '-m', `release: ${version}${trailer}`);
  git('tag', '-a', tag, '-m', `Atelier ${version}`);
  return git('rev-parse', 'HEAD');
}

// ---------------------------------------------------------------------------------------------------------------------
// A clean checkout of the tag, and the runner binaries

async function makeTree({ tag, tree, work, log }) {
  await exec('git', ['archive', '--format=tar.gz', '-o', join(work, 'src.tar.gz'), tag], { log });
  if (!existsSync(tree)) await exec('git', ['worktree', 'add', '--detach', tree, tag], { log });
  await exec('pnpm', ['install', '--frozen-lockfile'], { cwd: tree, log });
  // All six runner builds: each package bundles its own OS's two.
  await exec('pnpm', ['runner:build'], { cwd: tree, log, env: { PATH: `${process.env.PATH}:/usr/local/go/bin:/opt/homebrew/bin` } });
  await exec('tar', ['-czf', join(work, 'runner-bin.tar.gz'), '-C', join(tree, 'runner'), 'bin'], { log });
}

// ---------------------------------------------------------------------------------------------------------------------
// Linux: packages, and the server image's build (pushed later, after the question)

async function buildLinux({ tag, version, work, artifacts, log, skipImage, skipE2e, imageBase }) {
  const host = CONFIG.linux;
  const name = tag;
  await exec('ssh', [...SSH, host, 'mkdir -p ~/builds'], { log });
  await uploadTree({ host, ref: null, name, tarball: join(work, 'src.tar.gz'), runnerTar: join(work, 'runner-bin.tar.gz'), log });
  const env = 'export PATH=/usr/local/go/bin:$PATH CI=1';
  await exec('ssh', [...SSH, host, `${env}; cd ~/builds/${name} && pnpm install --frozen-lockfile`], { log });
  const packages = exec('ssh', [...SSH, host, `${env}; cd ~/builds/${name}/apps/desktop && node scripts/build.mjs && CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --config electron-builder.yml --linux --publish never`], { log });
  const image = skipImage ? Promise.resolve() : buildImages({ host, name, tag, imageBase, log });
  const e2e = skipE2e ? Promise.resolve() : runE2e({ host, name, log });
  await Promise.all([packages, image, e2e]);
  const dest = join(artifacts, 'linux');
  mkdirSync(dest, { recursive: true });
  const wanted = expectedFiles(version).linux;
  await exec('rsync', ['-a', '-e', `ssh ${SSH.join(' ')}`, ...wanted.flatMap((f) => ['--include', f]), '--exclude', '*', `${host}:builds/${name}/apps/desktop/release/`, `${dest}/`], { log });
}

async function buildImages({ host, name, tag, imageBase, log }) {
  const prep = 'docker buildx inspect atelier >/dev/null 2>&1 || docker buildx create --name atelier --driver docker-container >/dev/null; docker buildx use atelier';
  const build = (target) => `docker buildx build --platform linux/amd64,linux/arm64 -f apps/server/Dockerfile ${target ? `--target ${target} ` : ''}--build-arg ATELIER_VERSION=${tag} --build-arg ATELIER_IMAGE=${imageBase} --output type=cacheonly .`;
  // The main image first: the other two reuse its layers.
  await exec('ssh', [...SSH, host, `${prep}; cd ~/builds/${name} && ${build('')}`], { log });
  await Promise.all([exec('ssh', [...SSH, host, `${prep}; cd ~/builds/${name} && ${build('sandbox')}`], { log }), exec('ssh', [...SSH, host, `${prep}; cd ~/builds/${name} && ${build('updater')}`], { log })]);
}

/**
 * The whole end-to-end suite (the web app in a browser and the desktop app in Electron, under a virtual display), as CI
 * runs it on request. It works in a copy of the tree, because packaging rebuilds the desktop bundle in the other one.
 * One retry absorbs a slow first start of Electron.
 */
async function runE2e({ host, name, log }) {
  const script = [
    'set -eo pipefail',
    'export PATH=/usr/local/go/bin:$PATH CI=1',
    // Leftovers of an earlier run that was stopped (ssh does not stop what it started) would hold the test servers' ports.
    "pkill -u $USER -f 'e2e/serve.mjs|e2e/fake-ollama.mjs|apps/server/dist/server.mjs|playwright' || true",
    `rm -rf ~/builds/${name}-e2e && cp -a ~/builds/${name} ~/builds/${name}-e2e && cd ~/builds/${name}-e2e`,
    'pnpm --filter @atelier/server build >/dev/null 2>&1',
    'pnpm --filter @atelier/desktop build >/dev/null 2>&1',
    'pnpm exec playwright install chromium >/dev/null 2>&1',
    'node apps/desktop/node_modules/electron/install.js >/dev/null 2>&1',
    'ATELIER_SHOW_WINDOW=1 xvfb-run --auto-servernum pnpm e2e --retries=1 2>&1 | tail -40',
  ].join('\n');
  const r = await exec('ssh', [...SSH, host, 'bash -s'], { input: script, log, check: false });
  if (r.code !== 0) throw new Error(`The end-to-end tests failed on the Linux machine:\n${r.out.split('\n').slice(-40).join('\n')}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Windows: the installer

async function buildWindows({ version, work, artifacts, log }) {
  const host = CONFIG.windows;
  const root = CONFIG.windowsRoot;
  await exec('scp', ['-q', ...SSH, join(work, 'src.tar.gz'), `${host}:${root}/atelier-src.tar.gz`], { log });
  await exec('scp', ['-q', ...SSH, join(work, 'runner-bin.tar.gz'), `${host}:${root}/runner-bin.tar.gz`], { log });
  await exec('scp', ['-q', ...SSH, join(HERE, 'windows-build.ps1'), `${host}:${root}/release-build.ps1`], { log });
  const winRoot = root.replace(/\//g, '\\');
  await exec('ssh', [...SSH, host, `powershell -NoProfile -ExecutionPolicy Bypass -File ${winRoot}\\release-build.ps1 -Root ${winRoot}`], { log });
  const dest = join(artifacts, 'windows');
  mkdirSync(dest, { recursive: true });
  for (const file of expectedFiles(version).windows) {
    await exec('scp', ['-q', ...SSH, `${host}:${root}/src/apps/desktop/release/${file}`, join(dest, file)], { log });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// macOS: signed and notarized here, in the clean worktree

async function buildMac({ version, tree, artifacts, log }) {
  // The Mac must stay awake while Apple works on it.
  const awake = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  awake.unref();
  const mac = (...extra) => exec('node', ['apps/desktop/scripts/package-mac.mjs', ...extra], { cwd: tree, log, check: false });
  const state = join(tree, 'apps/desktop/release-mac/notarization.json');
  if (!existsSync(state)) {
    const r = await exec('pnpm', ['--filter', '@atelier/desktop', 'package:mac'], { cwd: tree, log });
    if (!/Both are with Apple/.test(r.out)) throw new Error('package:mac did not send both apps to Apple. See the log.');
  }
  const deadline = Date.now() + CONFIG.notaryTimeoutHours * 3_600_000;
  for (;;) {
    const status = parseNotarizationStatus((await mac('--status')).out);
    const answers = Object.values(status);
    if (answers.length === 2 && answers.every((s) => s === 'Accepted')) break;
    const bad = Object.entries(status).find(([, s]) => s === 'Invalid' || s === 'Rejected');
    if (bad) throw new Error(`Apple rejected the ${bad[0]} app (${bad[1]}). Read the log: ${log}`);
    if (Date.now() > deadline) throw new Error(`Apple has not finished in ${CONFIG.notaryTimeoutHours} hours (${JSON.stringify(status)}). Run the command again later: the submissions are kept.`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
  const done = await mac('--finish');
  if (done.code !== 0) throw new Error(`package:mac --finish failed. See the log: ${log}`);
  const dest = join(artifacts, 'mac');
  mkdirSync(dest, { recursive: true });
  for (const file of expectedFiles(version).mac) copyFileSync(join(tree, 'apps/desktop/release-mac', file), join(dest, file));
}

// ---------------------------------------------------------------------------------------------------------------------
// One folder, checked and signed

async function assemble({ version, platforms, artifacts, publish, log }) {
  rmSync(publish, { recursive: true, force: true });
  mkdirSync(publish, { recursive: true });
  for (const platform of platforms) {
    for (const file of readdirSync(join(artifacts, platform))) copyFileSync(join(artifacts, platform, file), join(publish, file));
  }
  const problems = checkRelease(publish, version, platforms);
  if (problems.length) throw new Error(`The built files don't add up:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  await exec('node', ['deploy/cloudflare/sign-release.mjs', publish], { log });
  const unsigned = readdirSync(publish).filter((f) => isPackage(f) && !existsSync(join(publish, `${f}.sig`)));
  if (unsigned.length) throw new Error(`Not signed: ${unsigned.join(', ')}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The question

async function confirm({ version, tag, channel, repo, publish, args, imageReady, skipped }) {
  const files = readdirSync(publish);
  const bytes = files.reduce((n, f) => n + statSync(join(publish, f)).size, 0);
  const commits = git('log', '--oneline', 'origin/main..HEAD').split('\n').filter(Boolean);
  console.log(
    [
      '',
      `Ready to publish Atelier ${version}:`,
      `  - git push origin main ${tag}  (${commits.length} commit${commits.length === 1 ? '' : 's'} not on GitHub yet)`,
      ...commits.slice(0, 8).map((c) => `        ${c.slice(0, 100)}`),
      `  - GitHub release in ${repo} (${files.length} files, ${(bytes / 1e9).toFixed(2)} GB)`,
      `  - the "${channel}" update feed at ${CONFIG.feed}: installed apps will offer ${version}`,
      imageReady ? `  - the server images ghcr.io/${repo.split('/')[0].toLowerCase()}/atelier(-sandbox, -updater):${tag}` : skipped('image') ? '  - (no server images: --skip image)' : '  - (no server images: the Linux machine is not logged in to ghcr.io; `docker login ghcr.io` there to include them)',
      channel === 'stable' ? '  - the website download list and the documentation' : '  - (no website change for a prerelease)',
      '',
    ].join('\n'),
  );
  if (args.yes) return;
  if (!process.stdin.isTTY) throw new Error('Not a terminal: pass --yes to publish without asking.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Publish? Type "publish" to go ahead: ')).trim();
  rl.close();
  if (answer !== 'publish') throw new Error('Not published. Run the command again to continue from here.');
}

// ---------------------------------------------------------------------------------------------------------------------
// Publishing

async function ghcrLogin() {
  const r = await exec('ssh', [...SSH, CONFIG.linux, `grep -q '"ghcr.io"' ~/.docker/config.json 2>/dev/null && echo yes`], { check: false });
  return r.out.includes('yes');
}

async function pushImages({ tag, repo, prerelease, log }) {
  const names = imageNames(repo, tag, prerelease);
  const name = tag;
  const push = (target, tags) =>
    exec('ssh', [...SSH, CONFIG.linux, `cd ~/builds/${name} && docker buildx use atelier && docker buildx build --platform linux/amd64,linux/arm64 -f apps/server/Dockerfile ${target ? `--target ${target} ` : ''}--build-arg ATELIER_VERSION=${tag} --build-arg ATELIER_IMAGE=${names.base} ${tags.map((t) => `-t ${t}`).join(' ')} --push .`], { log });
  await push('', names.main);
  await Promise.all([push('sandbox', names.sandbox), push('updater', names.updater)]);
}

async function githubRelease({ tag, version, repo, prerelease: pre, publish, notesFile, extra, log }) {
  const exists = (await exec('gh', ['release', 'view', tag, '--repo', repo], { check: false })).code === 0;
  if (!exists) {
    await exec('gh', ['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--title', `Atelier ${version}`, '--notes-file', notesFile, ...(pre ? ['--prerelease'] : [])], { log });
  }
  const files = [...readdirSync(publish).map((f) => join(publish, f)), ...(extra ?? [])];
  for (let i = 0; i < files.length; i += 8) await exec('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', ...files.slice(i, i + 8)], { log });
  await exec('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', ...(pre ? [] : ['--latest'])], { log });
}

async function deploySite({ tag, version, trailer, log }) {
  await exec('node', ['apps/site/scripts/releases.mjs', tag], { log });
  const list = JSON.parse(readFileSync(join(ROOT, 'apps/site/public/releases.json'), 'utf8'));
  const unmirrored = Object.values(list.assets).filter((a) => !a.url.startsWith(CONFIG.feed));
  if (unmirrored.length) throw new Error(`The download list still points at GitHub for ${unmirrored.map((a) => a.name).join(', ')}: the feed copy is missing or a different size.`);
  await exec('npx', ['--yes', 'wrangler@4', 'deploy', '-c', 'apps/site/wrangler.jsonc'], { log });
  if (git('status', '--porcelain', 'apps/site/public/releases.json')) {
    git('add', 'apps/site/public/releases.json');
    git('commit', '-m', `site: the download list shows ${version} [skip ci]${trailer}`);
    await exec('git', ['push', 'origin', 'main'], { log });
  }
}

async function deployDocs({ log }) {
  await exec('pnpm', ['--filter', '@atelier/docs', 'run', 'build'], { log });
  await exec('pnpm', ['--filter', '@atelier/docs', 'run', 'check'], { log });
  await exec('npx', ['--yes', 'wrangler@4', 'deploy'], { cwd: join(ROOT, 'apps/docs'), log });
}

// ---------------------------------------------------------------------------------------------------------------------
// The server installer: atelier-setup for four systems, and the one-line script that fetches the right one

const INSTALLER_TARGETS = [['linux', 'amd64'], ['linux', 'arm64'], ['darwin', 'amd64'], ['darwin', 'arm64']];

async function buildInstaller({ version, tree, work, log }) {
  const out = join(work, 'installer');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const sums = {};
  const env = { PATH: `${process.env.PATH}:/usr/local/go/bin:/opt/homebrew/bin`, CGO_ENABLED: '0' };
  await Promise.all(
    INSTALLER_TARGETS.map(async ([os, arch]) => {
      const name = `atelier-setup-${os}-${arch}`;
      await exec('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', join(out, name), './cmd/atelier-setup'], { cwd: join(tree, 'setup'), env: { ...env, GOOS: os, GOARCH: arch }, log });
      sums[name] = createHash('sha256').update(readFileSync(join(out, name))).digest('hex');
    }),
  );
  const template = readFileSync(join(tree, 'deploy/ship/install.sh.tmpl'), 'utf8');
  const script = renderInstaller(template, version, sums);
  writeFileSync(join(out, 'install.sh'), script);
  // The script must at least parse; running it is the person's job.
  await exec('sh', ['-n', join(out, 'install.sh')], { log });
  writeFileSync(join(out, 'SHA256SUMS'), Object.entries(sums).sort().map(([n, h]) => `${h}  ${n}`).join('\n') + '\n');
}

/** The feed Worker serves /install and /setup/...: redeploy it only when its code changed since the previous release. */
async function deployWorker({ tag, log }) {
  const previous = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').find((t) => t !== tag && /^v\d+\.\d+\.\d+$/.test(t));
  const changed = !previous || (await exec('git', ['diff', '--quiet', previous, tag, '--', 'deploy/cloudflare/src', 'deploy/cloudflare/wrangler.toml'], { check: false })).code !== 0;
  if (!changed) return say('the worker is unchanged since the last release');
  await exec('npx', ['--yes', 'wrangler@4', 'deploy'], { cwd: join(ROOT, 'deploy/cloudflare'), log });
}

async function publishInstaller({ version, prerelease, dir, log }) {
  const bucket = process.env.ATELIER_RELEASES_BUCKET ?? 'atelier-releases';
  const put = (key, file, type) => exec('npx', ['--yes', 'wrangler@4', 'r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--content-type', type, '--remote'], { cwd: join(ROOT, 'deploy/cloudflare'), log });
  for (const name of readdirSync(dir).filter((n) => n.startsWith('atelier-setup-'))) await put(`setup/${version}/${name}`, join(dir, name), 'application/octet-stream');
  await put(`setup/${version}/install.sh`, join(dir, 'install.sh'), 'text/x-shellscript');
  // /install always serves the newest stable script.
  if (!prerelease) await put('setup/install.sh', join(dir, 'install.sh'), 'text/x-shellscript');
}

// ---------------------------------------------------------------------------------------------------------------------
// What is live

async function verifyLive({ version, tag, channel, repo, publish, installerFiles }) {
  const problems = [];
  const names = readdirSync(publish);
  // The update feed: each update file names this version; each package is there at its size, with its signature.
  for (const file of names.filter((n) => /^latest.*\.yml$/.test(n))) {
    const res = await fetch(`${CONFIG.feed}/${channel}/${file}`).catch(() => null);
    if (!res?.ok) problems.push(`feed: ${file} is not served (${res?.status ?? 'no answer'})`);
    else if (parseUpdateFile(await res.text()).version !== version) problems.push(`feed: ${file} does not say ${version}`);
  }
  for (const file of names.filter(isPackage)) {
    const size = statSync(join(publish, file)).size;
    const head = await fetch(`${CONFIG.feed}/${channel}/${encodeURIComponent(file)}`, { method: 'HEAD' }).catch(() => null);
    if (!head?.ok) problems.push(`feed: ${file} is not served (${head?.status ?? 'no answer'})`);
    else if (Number(head.headers.get('content-length')) !== size) problems.push(`feed: ${file} is ${head.headers.get('content-length')} bytes there, ${size} here`);
    const sig = await fetch(`${CONFIG.feed}/${channel}/${encodeURIComponent(`${file}.sig`)}`, { method: 'HEAD' }).catch(() => null);
    if (!sig?.ok) problems.push(`feed: ${file}.sig is not served`);
  }
  // The installer: its script is served (stable), and each binary is there at its size.
  if (installerFiles) {
    for (const name of readdirSync(installerFiles).filter((n) => n.startsWith('atelier-setup-'))) {
      const head = await fetch(`${CONFIG.feed}/setup/${version}/${name}`, { method: 'HEAD' }).catch(() => null);
      if (!head?.ok) problems.push(`installer: ${name} is not served (${head?.status ?? 'no answer'})`);
      else if (Number(head.headers.get('content-length')) !== statSync(join(installerFiles, name)).size) problems.push(`installer: ${name} has another size there`);
    }
    if (channel === 'stable') {
      const script = await fetch(`${CONFIG.feed}/install`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
      if (script !== readFileSync(join(installerFiles, 'install.sh'), 'utf8')) problems.push('installer: /install does not serve this release\'s script');
    }
  }
  // The GitHub release: published, with every file at its size.
  const view = await exec('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets'], { check: false });
  if (view.code !== 0) problems.push('GitHub: the release is not there');
  else {
    const release = JSON.parse(view.out);
    if (release.isDraft) problems.push('GitHub: the release is still a draft');
    const have = new Map(release.assets.map((a) => [a.name, a.size]));
    for (const file of names) {
      if (!have.has(file)) problems.push(`GitHub: ${file} is missing`);
      else if (have.get(file) !== statSync(join(publish, file)).size) problems.push(`GitHub: ${file} has another size than the one built`);
    }
  }
  return problems;
}

// Run as a command; importing the file (to try a step on its own) runs nothing.
export { ghcrLogin, verifyLive, buildInstaller };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`\n${e.message}`);
    process.exit(1);
  });
}
