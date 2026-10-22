import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

/** Override both to run another checkout's suite alongside (e.g. ATELIER_E2E_WEB_PORT=7370 ATELIER_E2E_OLLAMA_PORT=11520). */
export const FAKE_OLLAMA_PORT = Number(process.env.ATELIER_E2E_OLLAMA_PORT ?? 11510);
export const WEB_PORT = Number(process.env.ATELIER_E2E_WEB_PORT ?? 7360);

/** e2e/serve.mjs starts the web server with this as ATELIER_SETUP_TOKEN. */
export const SETUP_TOKEN = 'atelier-e2e-setup-token';
/** The first account, created by the setup project; web specs run signed in as it. */
export const ADMIN = { username: 'tester', name: 'Tester', password: 'tester-password' };
export const ADMIN_STATE = 'e2e/.auth/admin.json';

/** A throwaway config dir whose settings point at the scripted fake Ollama, plus `extra` settings. Never the user's ~/.atelier. */
export async function tempConfigDir(extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-e2e-'));
  const settings = {
    profile: { name: 'Tester' },
    providers: [{ id: 'fake', type: 'ollama', name: 'Fake Ollama', baseUrl: `http://127.0.0.1:${FAKE_OLLAMA_PORT}` }],
    // Ask, so the specs see the prompts a scripted model's calls bring up (Auto would have a model review them).
    permissions: { defaultMode: 'default' },
    ...extra,
  };
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}

/** A throwaway git repository with `files` in one commit, and a committer of its own for the commits Atelier makes. */
export async function tempRepo(files: Record<string, string> = { 'README.md': '# Demo\n' }): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'atelier-e2e-repo-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Atelier E2E');
  git('config', 'user.email', 'e2e@example.invalid');
  // Git for Windows sets core.autocrlf machine-wide; these files are written with LF and compared exactly.
  git('config', 'core.autocrlf', 'false');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  git('add', '.');
  git('commit', '-qm', 'Initial commit');
  return repo;
}

/** For Code specs: the fake model turns each `call <Tool> <json>` line into one tool call, then replies with the last result. */
export const call = (tool: string, input: unknown) => `call ${tool} ${JSON.stringify(input)}`;

/**
 * Sends what the composer holds once the previous reply has finished. A message typed while the agent works would be
 * queued, so this waits until the run is over (no Stop button) and the box is ready to send.
 */
export async function sendWhenIdle(page: Page): Promise<void> {
  // Exactly Stop: a background task has a "Stop <its title>" button of its own.
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
}

/**
 * An HTML artifact that tries to escape the sandbox and reports what it managed to do.
 * Every probe must come back blocked.
 */
const PROBE_HTML = `<!doctype html><script>
const results = {};
const attempt = (name, fn) => { try { const v = fn(); results[name] = v === undefined ? 'no value' : 'LEAK: ' + String(v).slice(0, 40); } catch (e) { results[name] = 'blocked'; } };
attempt('parentDocument', () => parent.document.title);
attempt('topLocation', () => top.location.href);
attempt('cookie', () => document.cookie);
attempt('localStorage', () => localStorage.getItem('atelier-e2e'));
attempt('sessionStorage', () => sessionStorage.length);
const sameOrigin = new URL('/api/health', document.referrer || location.href).href;
const report = () => parent.postMessage({ probe: results }, '*');
fetch(sameOrigin).then((r) => { results.fetch = 'LEAK: ' + r.status; }, () => { results.fetch = 'blocked'; })
  .then(() => new Promise((done) => {
    const img = new Image();
    img.onload = () => { results.image = 'LEAK: loaded'; done(); };
    img.onerror = () => { results.image = 'blocked'; done(); };
    img.src = sameOrigin + '?leak=1';
  }))
  .then(report);
</script>`;

/** Frames the artifact runtime the way the app does and returns the probe results. Runs in the page. */
export async function probeArtifactSandbox(page: import('@playwright/test').Page, runtimeUrl: string): Promise<Record<string, string>> {
  return page.evaluate(
    async ({ runtimeUrl, html }) => {
      document.cookie = 'atelier-e2e=secret; path=/';
      localStorage.setItem('atelier-e2e', 'secret');
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.src = runtimeUrl;
      document.body.append(frame);
      return new Promise<Record<string, string>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the artifact runtime never answered')), 15_000);
        window.addEventListener('message', (event: MessageEvent) => {
          if (event.source !== frame.contentWindow) return;
          const data = event.data as { type?: string; probe?: Record<string, string> };
          if (data.type === 'ready') frame.contentWindow!.postMessage({ type: 'render', artifactType: 'html', content: html, theme: 'light' }, '*');
          if (data.probe) {
            clearTimeout(timer);
            resolve(data.probe);
          }
        });
      });
    },
    { runtimeUrl, html: PROBE_HTML },
  );
}

export const ALL_BLOCKED = {
  parentDocument: 'blocked',
  topLocation: 'blocked',
  cookie: 'blocked',
  localStorage: 'blocked',
  sessionStorage: 'blocked',
  fetch: 'blocked',
  image: 'blocked',
};

/**
 * Waits until an element stops moving. Clicks inside a frame are only checked for stability within the
 * frame, so a frame in a sliding panel needs this before clicking into it.
 */
export async function settled(locator: Locator): Promise<void> {
  let last = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await locator.boundingBox());
      const still = box === last;
      last = box;
      return still;
    }, { intervals: [100] })
    .toBe(true);
}

/** A one-page PDF that says "Hello PDF", for checking text extraction. */
export function tinyPdf(): Buffer {
  const stream = 'BT /F1 12 Tf 20 50 Td (Hello PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

/** Code's Verbose transcript view, where every call has its own card (Normal folds a run of calls into one line). */
export async function verboseTranscript(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Transcript view:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Verbose' }).click();
}
