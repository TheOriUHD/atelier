import { expect, test } from '@playwright/test';
import { ALL_BLOCKED, probeArtifactSandbox } from './fixtures.ts';

test('web: artifacts cannot reach the app, its storage or the network', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await probeArtifactSandbox(page, new URL('artifact-runtime/index.html', page.url()).href)).toEqual(ALL_BLOCKED);
});

test('web: the runtime renders React (with Recharts and Lucide, loaded on demand) and Markdown artifacts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const runtimeUrl = new URL('artifact-runtime/index.html', page.url()).href;
  const render = (artifactType: string, content: string) =>
    page.evaluate(
      ({ runtimeUrl, artifactType, content }) => {
        document.querySelectorAll('iframe').forEach((f) => f.remove());
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.src = runtimeUrl;
        document.body.append(frame);
        return new Promise<string>((resolve) => {
          window.addEventListener('message', (event: MessageEvent) => {
            if (event.source !== frame.contentWindow) return;
            const data = event.data as { type?: string; message?: string };
            if (data.type === 'ready') frame.contentWindow!.postMessage({ type: 'render', artifactType, content, theme: 'light' }, '*');
            if (data.type === 'rendered') resolve('rendered');
            if (data.type === 'error') resolve(`error: ${data.message}`);
          });
        });
      },
      { runtimeUrl, artifactType, content },
    );

  const app = `import { useState } from 'react';
import { Star } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar } from 'recharts';
export default function App() {
  const [n, setN] = useState(2);
  return <div><button onClick={() => setN(n + 1)}><Star size={16} /> Stars: {n}</button>
    <div style={{ width: 200, height: 100 }}><ResponsiveContainer><BarChart data={[{ v: 1 }, { v: n }]}><Bar dataKey="v" /></BarChart></ResponsiveContainer></div></div>;
}`;
  expect(await render('react', app)).toBe('rendered');
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Stars: 2' }).click();
  await expect(frame.getByRole('button', { name: 'Stars: 3' })).toBeVisible();

  expect(await render('markdown', '# Notes\n\n- one\n- two')).toBe('rendered');
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Notes' })).toBeVisible();
});
