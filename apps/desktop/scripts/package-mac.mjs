#!/usr/bin/env node
/**
 * Builds the signed and notarized macOS packages (Developer ID), on a Mac that has the certificate. Apple's notarization
 * can take minutes, or hours or days for a new account's first submissions, so this never waits for it: it signs and
 * submits, and you come back with `--finish` whenever (the Mac can sleep or go offline in between).
 *
 *   pnpm --filter @atelier/desktop package:mac             sign Apple silicon and Intel side by side, send both to Apple, and stop
 *   pnpm --filter @atelier/desktop package:mac --finish    ask Apple; for each app it accepted: staple, check, make the
 *                                                          disk image and zip in release-mac/ (the other waits)
 *   pnpm --filter @atelier/desktop package:mac --status    just ask Apple
 *   pnpm --filter @atelier/desktop package:mac --feed      rewrite release-mac/latest-mac.yml from the finished files
 *
 * Other flags: `--arch arm64|x64` (repeatable) limits any of the above to one architecture, `--sign-only` stops after
 * signing, `--submit` sends apps that are already signed (a submission that failed, say because the keychain locked
 * while the apps were signing, needn't sign again), `--force` sends new submissions over ones already with Apple.
 *
 * It needs, once per Mac (docs/updates.md): a "Developer ID Application" certificate in the keychain (found by itself)
 * and a notarization login saved with `xcrun notarytool store-credentials "atelier-notary" ...` (another name:
 * APPLE_KEYCHAIN_PROFILE). Both are checked first. The submissions are remembered in release-mac/notarization-<arch>.json,
 * and a second `package:mac` refuses to send the same builds again (duplicates only lengthen Apple's queue); `--force` does.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHS, macFeedNames, macFiles, macPackages, parseMacArgs, renderMacFeed } from './mac-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Its own folder, so an ordinary build (which writes to release/) can never replace an app that is with Apple.
const release = join(root, 'release-mac');
const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'atelier-notary';
const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};
let args;
try {
  args = parseMacArgs(process.argv.slice(2));
} catch (e) {
  fail(e.message);
}
const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) fail(`${command} ${argv.join(' ')} failed (${result.status}).`);
};
/**
 * Runs a program without blocking, so the two architectures go side by side. Each output line is marked with the
 * architecture, because the lines of both end up in one log. Resolves with the program's output.
 */
const runAsync = (label, command, argv, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let out = '';
    let err = '';
    const echo = (stream, sink) => {
      let pending = '';
      stream.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (sink === 'out') out += text;
        else err += text;
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) if (options.quiet !== true) console.log(`[${label}] ${line}`);
      });
    };
    echo(child.stdout, 'out');
    echo(child.stderr, 'err');
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${command} ${argv.slice(0, 3).join(' ')} failed (${code}).\n${(err || out).trim().split('\n').slice(-6).join('\n')}`))));
  });
const capture = (command, argv) => spawnSync(command, argv, { encoding: 'utf8' });
const readState = (arch) => (existsSync(macFiles.state(release, arch)) ? JSON.parse(readFileSync(macFiles.state(release, arch), 'utf8')) : null);
const writeState = (arch, state) => writeFileSync(macFiles.state(release, arch), JSON.stringify(state, null, 2) + '\n');

if (process.platform !== 'darwin') fail('Signing and notarizing a macOS app needs a Mac.');

function checkLogin() {
  const login = capture('xcrun', ['notarytool', 'history', '--keychain-profile', profile]);
  if (login.status !== 0) {
    fail(
      `The notarization login "${profile}" doesn't work: ${(login.stderr || login.stdout).trim().split('\n')[0]}\nMake it with: xcrun notarytool store-credentials "${profile}" --apple-id <your Apple ID> --team-id <your team id>\nA locked screen locks the keychain too: unlock the Mac, then run this again with --submit to send the apps that are already signed.`,
    );
  }
}

/** Signs one architecture's app with electron-builder (no notarization: that is done here, so it can be left waiting). */
async function signApp(arch, identity) {
  rmSync(macFiles.signed(release, arch), { force: true });
  // A leftover from unsigned builds ("don't look for a certificate") would stop the signing.
  const env = { ...process.env };
  delete env.CSC_IDENTITY_AUTO_DISCOVERY;
  await runAsync(arch, 'pnpm', ['exec', 'electron-builder', '--config', 'electron-builder.signed.yml', `-c.mac.identity=${identity}`, '-c.mac.notarize=false', '-c.directories.output=release-mac', '--mac', 'dir', `--${arch}`, '--publish', 'never'], { env });
  writeFileSync(macFiles.signed(release, arch), `${new Date().toISOString()}\n`);
}

/** Zips a signed app and hands it to Apple without waiting; the ticket number is kept for --finish. */
async function sendApp(arch) {
  const app = macFiles.app(release, arch);
  const zip = macFiles.zip(release, arch);
  await runAsync(arch, 'ditto', ['-c', '-k', '--keepParent', app, zip]);
  const sent = await runAsync(arch, 'xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--no-wait', '--output-format', 'json'], { quiet: true }).catch((e) => {
    throw new Error(`Sending ${arch} to Apple failed: ${e.message}`);
  });
  const state = { id: JSON.parse(sent.out).id, app, sentAt: new Date().toISOString() };
  writeState(arch, state);
  console.log(`  ${arch}: sent to Apple, submission ${state.id}`);
}

async function submit(archs) {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identity = /"Developer ID Application: (.+? \([A-Z0-9]{10}\))"/.exec(identities)?.[1];
  if (!identity)
    fail(
      'No "Developer ID Application" certificate in the keychain. Create one in Xcode (Settings › Accounts › Manage Certificates › +); see docs/updates.md.',
    );
  console.log(`Signing as: Developer ID Application: ${identity}`);
  if (!args.signOnly) checkLogin();

  const waiting = archs.filter((arch) => readState(arch));
  if (waiting.length && !args.force) {
    fail(`Submissions are already with Apple (${waiting.map((arch) => `${arch} ${readState(arch).id}`).join(', ')}). Run with --finish to collect them, or --force to send new ones.`);
  }
  for (const arch of archs) rmSync(macFiles.state(release, arch), { force: true });

  if (args.resume) {
    const unsigned = archs.filter((arch) => !existsSync(macFiles.signed(release, arch)) || !existsSync(macFiles.app(release, arch)));
    if (unsigned.length) fail(`${unsigned.join(' and ')} ${unsigned.length === 1 ? "isn't" : "aren't"} signed yet: run package:mac without --submit.`);
  } else {
    run('node', ['scripts/build.mjs']);
    // The computer use helper (native/computer-macos), for both architectures in one file; electron-builder signs it with the app.
    run('pnpm', ['--workspace-root', 'computer:build']);
    // Electron's and Chromium's license files go into the app (electron-builder.yml). They come with Electron's own
    // download, which a fresh install (pnpm doesn't run Electron's install script) hasn't made yet.
    if (!existsSync(join(root, 'node_modules/electron/dist/LICENSES.chromium.html'))) run('node', ['node_modules/electron/install.js']);
  }
  // Each architecture signs and is sent on its own: signing takes minutes of one codesign call after another, so the
  // two side by side take as long as one, and the first to be signed is with Apple while the other is still signing.
  const results = await Promise.allSettled(
    archs.map(async (arch) => {
      if (!args.resume) await signApp(arch, identity);
      if (!args.signOnly) await sendApp(arch);
    }),
  );
  const problems = results.map((r, i) => (r.status === 'rejected' ? `${archs[i]}: ${r.reason.message}` : null)).filter(Boolean);
  if (problems.length) fail(`${problems.join('\n')}\n${archs.some((arch) => existsSync(macFiles.signed(release, arch))) ? 'What is signed is kept: run again with --submit to send it.' : ''}`);
  console.log(
    args.signOnly
      ? '\nSigned. Send the apps to Apple with: pnpm --filter @atelier/desktop package:mac --submit'
      : '\nBoth are with Apple. Close the lid if you like; later run: pnpm --filter @atelier/desktop package:mac --finish',
  );
}

function answers(archs) {
  return archs.map((arch) => {
    const entry = readState(arch);
    const info = capture('xcrun', ['notarytool', 'info', entry.id, '--keychain-profile', profile, '--output-format', 'json']);
    const status = info.status === 0 ? JSON.parse(info.stdout).status : `unknown (${(info.stderr || info.stdout).trim().split('\n')[0]})`;
    return { arch, ...entry, status };
  });
}

/**
 * electron-updater's feed for macOS (`latest-mac.yml`) lists every build, for both architectures, and the app picks its
 * own. Each architecture is packaged in a run of its own here, which would leave only the last one in the file, so it is
 * written from the finished files instead.
 */
function writeFeed() {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const names = macFeedNames(version);
  const missing = names.filter((n) => !existsSync(join(release, n)));
  if (missing.length) fail(`Can't write latest-mac.yml: ${missing.join(', ')} not in release-mac. Run package:mac --finish first.`);
  const entries = names.map((url) => {
    const file = join(release, url);
    return { url, sha512: createHash('sha512').update(readFileSync(file)).digest('base64'), size: statSync(file).size };
  });
  writeFileSync(join(release, 'latest-mac.yml'), renderMacFeed(version, entries, new Date().toISOString()));
  console.log('  latest-mac.yml lists both architectures.');
}

function finish(archs) {
  checkLogin();
  const found = answers(archs);
  for (const s of found) console.log(`  ${s.arch}: ${s.status}  (${s.id}, sent ${s.sentAt})`);
  if (args.mode === 'status') return;

  const rejected = found.filter((s) => s.status === 'Invalid' || s.status === 'Rejected');
  for (const s of rejected) {
    console.error(`\nApple rejected ${s.arch}:`);
    run('xcrun', ['notarytool', 'log', s.id, '--keychain-profile', profile]);
  }
  if (rejected.length) fail('Fix what the log says, then run package:mac --force.');
  if (found.some((s) => s.status !== 'Accepted')) {
    console.log('\nApple is not done yet. Nothing is lost: run this again later.');
    process.exit(2);
  }

  // Accepted: put the ticket in the apps, check them, then make the images from these very apps. They are not signed
  // again (that would change the signature the ticket belongs to).
  let bad = 0;
  for (const s of found) {
    run('xcrun', ['stapler', 'staple', s.app]);
    const check = (label, command, argv) => {
      const result = capture(command, argv);
      if (result.status !== 0) bad++;
      console.log(`  ${result.status === 0 ? 'ok ' : 'BAD'} ${s.arch}: ${label}${result.status === 0 ? '' : `: ${(result.stderr || result.stdout).trim().split('\n').pop()}`}`);
    };
    check('signature is valid, nested code included', 'codesign', ['--verify', '--deep', '--strict', s.app]);
    check('Gatekeeper accepts it (notarized Developer ID)', 'spctl', ['--assess', '--type', 'execute', '--verbose=2', s.app]);
    check('notarization ticket is stapled', 'xcrun', ['stapler', 'validate', s.app]);
  }
  if (bad) fail(`${bad} check(s) failed.`);
  for (const s of found) {
    run('pnpm', ['exec', 'electron-builder', '--config', 'electron-builder.signed.yml', '-c.mac.identity=null', '-c.mac.notarize=false', '-c.directories.output=release-mac', '--mac', 'dmg', 'zip', `--${s.arch}`, '--prepackaged', s.app, '--publish', 'never']);
    // This architecture is done: its own leftovers go (the other may still be with Apple).
    rmSync(macFiles.zip(release, s.arch), { force: true });
    rmSync(macFiles.state(release, s.arch), { force: true });
  }
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (ARCHS.every((arch) => macPackages(version, arch).every((n) => existsSync(join(release, n))))) {
    writeFeed();
    console.log('\nSigned and notarized. The disk images and zips are in apps/desktop/release-mac.');
  } else console.log(`\n${found.map((s) => s.arch).join(' and ')} signed and notarized. latest-mac.yml is written when the other architecture is done too.`);
}

if (args.mode === 'feed') writeFeed();
else if (args.mode === 'finish' || args.mode === 'status') {
  // Those that are with Apple, unless --arch names them.
  const archs = args.archs ?? ARCHS.filter((arch) => readState(arch));
  const missing = archs.filter((arch) => !readState(arch));
  if (!archs.length || missing.length) fail(`${missing.length ? missing.join(' and ') : 'Nothing'} ${missing.length > 1 ? 'are' : 'is'} not with Apple. Run package:mac first.`);
  finish(archs);
} else await submit(args.archs ?? ARCHS);
