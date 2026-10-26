#!/usr/bin/env node
/**
 * Builds the signed and notarized macOS packages (Developer ID), on a Mac that has the certificate. Apple's notarization
 * can take minutes, or hours or days for a new account's first submissions, so this never waits for it: it signs and
 * submits, and you come back with `--finish` whenever (the Mac can sleep or go offline in between).
 *
 *   pnpm --filter @atelier/desktop package:mac             sign Apple silicon and Intel, send both to Apple, and stop
 *   pnpm --filter @atelier/desktop package:mac --finish    ask Apple; when both are accepted: staple, check, make the
 *                                                          disk images and zips in release/
 *   pnpm --filter @atelier/desktop package:mac --status    just ask Apple
 *   pnpm --filter @atelier/desktop package:mac --feed      rewrite release-mac/latest-mac.yml from the finished files
 *
 * It needs, once per Mac (docs/updates.md): a "Developer ID Application" certificate in the keychain (found by itself)
 * and a notarization login saved with `xcrun notarytool store-credentials "atelier-notary" ...` (another name:
 * APPLE_KEYCHAIN_PROFILE). Both are checked first. The submissions are remembered in release/notarization.json, and a
 * second `package:mac` refuses to send the same builds again (duplicates only lengthen Apple's queue); `--force` does.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Its own folder, so an ordinary build (which writes to release/) can never replace an app that is with Apple.
const release = join(root, 'release-mac');
const stateFile = join(release, 'notarization.json');
const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'atelier-notary';
const flags = new Set(process.argv.slice(2));
const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed (${result.status}).`);
};
const capture = (command, args) => spawnSync(command, args, { encoding: 'utf8' });
const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {});
const writeState = (state) => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');

if (process.platform !== 'darwin') fail('Signing and notarizing a macOS app needs a Mac.');

function checkLogin() {
  const login = capture('xcrun', ['notarytool', 'history', '--keychain-profile', profile]);
  if (login.status !== 0) {
    fail(
      `The notarization login "${profile}" doesn't work: ${(login.stderr || login.stdout).trim().split('\n')[0]}\nMake it with: xcrun notarytool store-credentials "${profile}" --apple-id <your Apple ID> --team-id <your team id>`,
    );
  }
}

/** Where each architecture's app is built (electron-builder names the Intel one plain "mac"). */
const apps = { arm64: join(release, 'mac-arm64', 'Atelier.app'), x64: join(release, 'mac', 'Atelier.app') };

function submit() {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identity = /"Developer ID Application: (.+? \([A-Z0-9]{10}\))"/.exec(identities)?.[1];
  if (!identity)
    fail(
      'No "Developer ID Application" certificate in the keychain. Create one in Xcode (Settings › Accounts › Manage Certificates › +); see docs/updates.md.',
    );
  console.log(`Signing as: Developer ID Application: ${identity}`);
  checkLogin();

  const waiting = readState();
  if (Object.keys(waiting).length && !flags.has('--force')) {
    fail(
      `Submissions are already with Apple (${Object.values(waiting)
        .map((s) => s.id)
        .join(', ')}). Run with --finish to collect them, or --force to send new ones.`,
    );
  }

  run('node', ['scripts/build.mjs']);
  // The computer use helper (native/computer-macos), for both architectures in one file; electron-builder signs it with the app.
  run('pnpm', ['--workspace-root', 'computer:build']);
  // Electron's and Chromium's license files go into the app (electron-builder.yml). They come with Electron's own
  // download, which a fresh install (pnpm doesn't run Electron's install script) hasn't made yet.
  if (!existsSync(join(root, 'node_modules/electron/dist/LICENSES.chromium.html'))) run('node', ['node_modules/electron/install.js']);
  // A leftover from unsigned builds ("don't look for a certificate") would stop the signing. Signing only: the notarization
  // is done here, so it can be left waiting.
  const env = { ...process.env };
  delete env.CSC_IDENTITY_AUTO_DISCOVERY;
  run(
    'pnpm',
    [
      'exec',
      'electron-builder',
      '--config',
      'electron-builder.signed.yml',
      `-c.mac.identity=${identity}`,
      '-c.mac.notarize=false',
      '-c.directories.output=release-mac',
      '--mac',
      'dir',
      '--arm64',
      '--x64',
      '--publish',
      'never',
    ],
    { env },
  );

  const state = {};
  for (const [arch, app] of Object.entries(apps)) {
    const zip = join(release, `notarize-${arch}.zip`);
    run('ditto', ['-c', '-k', '--keepParent', app, zip]);
    const sent = capture('xcrun', [
      'notarytool',
      'submit',
      zip,
      '--keychain-profile',
      profile,
      '--no-wait',
      '--output-format',
      'json',
    ]);
    if (sent.status !== 0) fail(`Sending ${arch} to Apple failed: ${(sent.stderr || sent.stdout).trim()}`);
    state[arch] = { id: JSON.parse(sent.stdout).id, app, sentAt: new Date().toISOString() };
    console.log(`  ${arch}: sent to Apple, submission ${state[arch].id}`);
  }
  writeState(state);
  console.log(
    '\nBoth are with Apple. Close the lid if you like; later run: pnpm --filter @atelier/desktop package:mac --finish',
  );
}

function answers(state) {
  return Object.entries(state).map(([arch, entry]) => {
    const info = capture('xcrun', [
      'notarytool',
      'info',
      entry.id,
      '--keychain-profile',
      profile,
      '--output-format',
      'json',
    ]);
    const status =
      info.status === 0
        ? JSON.parse(info.stdout).status
        : `unknown (${(info.stderr || info.stdout).trim().split('\n')[0]})`;
    return { arch, ...entry, status };
  });
}

/**
 * electron-updater's feed for macOS (`latest-mac.yml`) lists every build, for both architectures, and the app picks its
 * own. Each architecture is packaged in a run of its own here, which would leave only the last one in the file, so it is
 * written from the finished files instead, in the order electron-builder uses (zips, then disk images; Intel first).
 */
function writeFeed() {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const names = [
    `Atelier-${version}-mac.zip`,
    `Atelier-${version}-arm64-mac.zip`,
    `Atelier-${version}.dmg`,
    `Atelier-${version}-arm64.dmg`,
  ];
  const missing = names.filter((n) => !existsSync(join(release, n)));
  if (missing.length)
    fail(`Can't write latest-mac.yml: ${missing.join(', ')} not in release-mac. Run package:mac --finish first.`);
  const entries = names.map((url) => {
    const file = join(release, url);
    return { url, sha512: createHash('sha512').update(readFileSync(file)).digest('base64'), size: statSync(file).size };
  });
  const lines = ['version: ' + version, 'files:'];
  for (const e of entries) lines.push(`  - url: ${e.url}`, `    sha512: ${e.sha512}`, `    size: ${e.size}`);
  lines.push(
    `path: ${entries[0].url}`,
    `sha512: ${entries[0].sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  );
  writeFileSync(join(release, 'latest-mac.yml'), lines.join('\n'));
  console.log('  latest-mac.yml lists both architectures.');
}

function finish() {
  checkLogin();
  const state = readState();
  if (!Object.keys(state).length) fail('Nothing is with Apple. Run package:mac first.');
  const found = answers(state);
  for (const s of found) console.log(`  ${s.arch}: ${s.status}  (${s.id}, sent ${s.sentAt})`);
  if (flags.has('--status')) return;

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
    const check = (label, command, args) => {
      const result = capture(command, args);
      if (result.status !== 0) bad++;
      console.log(
        `  ${result.status === 0 ? 'ok ' : 'BAD'} ${s.arch}: ${label}${result.status === 0 ? '' : `: ${(result.stderr || result.stdout).trim().split('\n').pop()}`}`,
      );
    };
    check('signature is valid, nested code included', 'codesign', ['--verify', '--deep', '--strict', s.app]);
    check('Gatekeeper accepts it (notarized Developer ID)', 'spctl', [
      '--assess',
      '--type',
      'execute',
      '--verbose=2',
      s.app,
    ]);
    check('notarization ticket is stapled', 'xcrun', ['stapler', 'validate', s.app]);
  }
  if (bad) fail(`${bad} check(s) failed.`);
  for (const s of found) {
    run('pnpm', [
      'exec',
      'electron-builder',
      '--config',
      'electron-builder.signed.yml',
      '-c.mac.identity=null',
      '-c.mac.notarize=false',
      '-c.directories.output=release-mac',
      '--mac',
      'dmg',
      'zip',
      `--${s.arch}`,
      '--prepackaged',
      s.app,
      '--publish',
      'never',
    ]);
  }
  writeFeed();
  for (const f of readdirSync(release).filter((f) => /^notarize-.*\.zip$/.test(f))) run('rm', ['-f', join(release, f)]);
  run('rm', ['-f', stateFile]);
  console.log('\nSigned and notarized. The disk images and zips are in apps/desktop/release-mac.');
}

if (flags.has('--feed')) writeFeed();
else if (flags.has('--finish') || flags.has('--status')) finish();
else submit();
