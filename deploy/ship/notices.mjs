#!/usr/bin/env node
/**
 * Writes the third-party notices for what Atelier ships, from the installed dependencies:
 *
 *   THIRD_PARTY_NOTICES.md                      the desktop app and the server image (npm packages, the runner's Go
 *                                               modules), copied into both by their builds
 *   setup/internal/notices/NOTICES.txt          the setup program's Go modules, embedded in it (`atelier-setup licenses`)
 *   apps/site/public/fonts/OFL.txt, apps/docs/public/fonts/OFL.txt   the licenses of the fonts those sites serve
 *
 *   pnpm notices            write them
 *   pnpm notices --check    exit 1 when a written file is out of date (the release command runs this)
 *
 * The npm side follows the runtime dependencies of the packages whose code is bundled (ui, core, protocol, server, and
 * electron-updater in the desktop app), through pnpm's node_modules, and includes each package's own LICENSE, COPYING
 * and NOTICE files. The Go side lists the modules the binaries link (`go list -deps`) with the license files in the
 * module cache. Electron's and Chromium's licenses ship with the desktop app (electron-builder.yml).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');

/** The workspace packages whose code ends up in the app or the image, and outside packages bundled besides. */
const BUNDLED = ['packages/ui', 'packages/core', 'packages/protocol', 'apps/server'];
const EXTRA = [{ from: 'apps/desktop', name: 'electron-updater' }];
const LICENSE_FILE = /^(licen[sc]e|copying|notice)(\.(md|txt|markdown|rst))?$/i;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) || /^licen[sc]e[-_.]/i.test(f))
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim());
}

/** The folder of `name` as seen from a package in `fromDir`: node's lookup, walking up through node_modules. */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dirname(dir) === dir) return null;
  }
}

function npmPackages() {
  const found = new Map();
  const workspace = new Set();
  const visit = (name, fromDir, optional) => {
    const dir = resolvePackage(name, fromDir);
    if (!dir) {
      if (optional) return; // an optional dependency for another platform
      throw new Error(`${name} is not installed (needed by ${relative(repo, fromDir) || '.'}); run pnpm install`);
    }
    const pkg = readJson(join(dir, 'package.json'));
    // A platform's prebuilt binary (os/cpu set): its parent package is listed with the same license, and leaving these
    // out keeps the file the same on every build machine.
    if (pkg.os || pkg.cpu) return;
    if (!dir.includes('node_modules')) {
      // A workspace package: its code is bundled, so its dependencies are what ships.
      if (workspace.has(dir)) return;
      workspace.add(dir);
      walk(dir, pkg);
      return;
    }
    const key = `${pkg.name}@${pkg.version}`;
    if (found.has(key)) return;
    const texts = licenseFiles(dir);
    found.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: declared(pkg) === 'UNKNOWN' ? guess(texts) : declared(pkg),
      url: homepage(pkg),
      texts,
      author: typeof pkg.author === 'string' ? pkg.author.replace(/\s*[<(].*$/, '') : pkg.author?.name,
    });
    walk(dir, pkg);
  };
  const walk = (dir, pkg) => {
    for (const name of Object.keys(pkg.dependencies ?? {})) visit(name, dir, false);
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) visit(name, dir, true);
  };
  for (const root of BUNDLED) walk(join(repo, root), readJson(join(repo, root, 'package.json')));
  for (const { from, name } of EXTRA) visit(name, join(repo, from), false);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
}

function declared(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  return pkg.license?.type ?? ((pkg.licenses ?? []).map((l) => l.type).join(' OR ') || 'UNKNOWN');
}

/** The standard text of a declared license, for a package that ships no license file. */
function standardText(e) {
  const holder = e.author ? `${e.author} and contributors` : `the authors of ${e.name}`;
  if (/^MIT\b/.test(e.license)) {
    return `MIT License\n\nCopyright (c) ${holder}\n\n${MIT_BODY}`;
  }
  if (/^ISC\b/.test(e.license)) {
    return `ISC License\n\nCopyright (c) ${holder}\n\n${ISC_BODY}`;
  }
  if (/Apache-2\.0/.test(e.license)) return 'Apache License, Version 2.0: the same text as the Apache-2.0 packages in this file (https://www.apache.org/licenses/LICENSE-2.0).';
  return `${e.license}, as declared in its package.json.`;
}

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const ISC_BODY = `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.`;

function homepage(pkg) {
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const url = pkg.homepage || repoUrl || `https://www.npmjs.com/package/${pkg.name}`;
  return url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/');
}

/** The modules a Go main package links, with their license files from the module cache. */
function goModules(moduleDir, pkg) {
  const out = execFileSync('go', ['list', '-deps', '-json', pkg], { cwd: join(repo, moduleDir), encoding: 'utf8', maxBuffer: 64 << 20 });
  const modules = new Map();
  for (const chunk of out.split(/\n(?=\{)/)) {
    const m = JSON.parse(chunk).Module;
    if (!m || m.Main) continue;
    const mod = m.Replace ?? m;
    if (modules.has(mod.Path)) continue;
    if (!mod.Dir) throw new Error(`${mod.Path} is not in the module cache; run go mod download in ${moduleDir}`);
    const texts = licenseFiles(mod.Dir);
    modules.set(mod.Path, { name: mod.Path, version: mod.Version, license: guess(texts), url: `https://pkg.go.dev/${mod.Path}`, texts });
  }
  return [...modules.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function guess(texts) {
  const text = texts.join('\n');
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Redistribution and use in source and binary forms/i.test(text)) return /Neither the name/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/Mozilla Public License,? v(ersion)? ?2\.0/i.test(text)) return 'MPL-2.0';
  if (/ISC License|Permission to use, copy, modify, and\/or distribute/i.test(text)) return 'ISC';
  return 'see the text';
}

/** Packages with the same license text share one copy of it, so the file stays readable. */
function section(title, intro, entries) {
  const groups = new Map();
  for (const e of entries) {
    const text = e.texts.length ? e.texts.join('\n\n---\n\n') : `(No license file in the package; the declared license's standard text.)\n\n${standardText(e)}`;
    const group = groups.get(text) ?? { license: e.license, entries: [] };
    group.entries.push(e);
    groups.set(text, group);
  }
  const lines = [`## ${title}`, '', intro, ''];
  const sorted = [...groups.entries()].sort((a, b) => a[1].entries[0].name.localeCompare(b[1].entries[0].name));
  for (const [text, group] of sorted) {
    for (const e of group.entries) lines.push(`- **${e.name}** ${e.version} (${e.license}): ${e.url}`);
    lines.push('');
    lines.push('```text', text.replace(/```/g, "'''"), '```', '');
  }
  return lines.join('\n');
}

const HEADER = `# Third-party notices

Atelier is licensed under the PolyForm Noncommercial License 1.0.0 (see LICENSE). It includes the third-party software
below, each under its own license. This file is generated by \`pnpm notices\` (deploy/ship/notices.mjs); don't edit it
by hand. The desktop app also ships Electron's and Chromium's license files (LICENSE.electron.txt and
LICENSES.chromium.html: beside the app on Windows and Linux, in its resources on macOS), and the server image's
operating system packages keep theirs in /usr/share/doc.
`;

function fontsOfl() {
  const dirs = ['@fontsource-variable/inter', '@fontsource-variable/source-serif-4', '@fontsource-variable/jetbrains-mono'];
  const parts = dirs.map((name) => {
    const dir = resolvePackage(name, join(repo, 'packages/ui'));
    if (!dir) throw new Error(`${name} is not installed; run pnpm install`);
    return licenseFiles(dir).join('\n\n');
  });
  return `The fonts in this folder are subsets of Inter, Source Serif 4 and JetBrains Mono (from Fontsource), each licensed under
the SIL Open Font License, Version 1.1. Their copyright notices and the license follow.

${parts.join('\n\n==========\n\n')}
`;
}

const npm = npmPackages();
const runner = goModules('runner', './cmd/atelier-runner');
const setup = goModules('setup', './cmd/atelier-setup');

const files = {
  'THIRD_PARTY_NOTICES.md': [
    HEADER,
    section('JavaScript packages', 'Bundled into the desktop app and the server (the interface, the backend and the server).', npm),
    section('Go modules in the runner', 'Linked into atelier-runner, which the desktop app and the server image ship and copy to SSH hosts.', runner),
    section('Go modules in the setup program', 'Linked into atelier-setup, the server installer (also listed by `atelier-setup licenses`).', setup),
  ].join('\n'),
  'setup/internal/notices/NOTICES.txt': [
    'atelier-setup includes the third-party Go modules below, each under its own license.',
    'Atelier itself is licensed under the PolyForm Noncommercial License 1.0.0: https://github.com/TheOriUHD/atelier',
    '',
    ...setup.flatMap((m) => [`== ${m.name} ${m.version} (${m.license}) ==`, '', m.texts.join('\n\n') || `${m.license}, as declared.`, '']),
  ].join('\n'),
  'apps/site/public/fonts/OFL.txt': fontsOfl(),
  'apps/docs/public/fonts/OFL.txt': fontsOfl(),
};

let stale = [];
for (const [rel, text] of Object.entries(files)) {
  const file = join(repo, rel);
  const body = text.endsWith('\n') ? text : `${text}\n`;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (current === body) continue;
  if (check) stale.push(rel);
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
    console.log(`wrote ${rel}`);
  }
}
if (check && stale.length) {
  console.error(`Third-party notices are out of date: ${stale.join(', ')}. Run pnpm notices and commit the result.`);
  process.exit(1);
}
if (!check) console.log(`${npm.length} npm packages, ${runner.length} runner modules, ${setup.length} setup modules`);
