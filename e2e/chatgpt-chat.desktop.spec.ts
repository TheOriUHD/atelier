import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { tempConfigDir } from './fixtures.ts';

type ReplyLayout = 'legacy' | 'current' | 'marked-only' | 'mixed' | 'paused' | 'revised';
const fixture = (legacy: boolean, layout: ReplyLayout, fast: boolean) => `<!doctype html><title>ChatGPT fixture</title>
${legacy ? '' : '<textarea id="prompt-textarea" hidden></textarea>'}
<script>
window.pageLoadId = Math.random();
setTimeout(() => {
  document.body.insertAdjacentHTML('beforeend', '<form id="composer">${legacy ? '<textarea id="prompt-textarea"></textarea>' : '<div class="ProseMirror" role="textbox" contenteditable="true"><p><br></p></div>'}${legacy ? '<button type="submit" aria-label="Send prompt" disabled>Send</button>' : ''}</form>${legacy ? '' : '<button form="composer" disabled>Localized send</button>'}');
  const form = document.querySelector('form');
  const editor = form.querySelector('[contenteditable], textarea');
  let value = '';
  const text = () => editor instanceof HTMLTextAreaElement ? editor.value : value;
  const send = [...form.elements].find(element => element instanceof HTMLButtonElement);
  if (!(editor instanceof HTMLTextAreaElement)) editor.addEventListener('beforeinput', event => {
    event.preventDefault();
    value += event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak' ? '\\n' : event.data || '';
    editor.replaceChildren(...value.split('\\n').map(line => {
      const p = document.createElement('p');
      p.append(document.createTextNode(line));
      const br = document.createElement('br'); br.className = 'ProseMirror-trailingBreak'; p.append(br);
      return p;
    }));
    const selection = window.getSelection(); selection.selectAllChildren(editor); selection.collapseToEnd();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  editor.addEventListener('input', () => setTimeout(() => { send.disabled = !text().trim(); }, 150));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const submitted = text();
    document.body.dataset.submitted = submitted;
    fetch('/__atelier_test/submitted', { method: 'POST', body: submitted });
    // As the real page does: the field empties once the message is on its way.
    if (editor instanceof HTMLTextAreaElement) editor.value = '';
    else { value = ''; editor.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>'; }
    send.disabled = true;
    form.insertAdjacentHTML('beforeend', '<button type="button" data-testid="stop-button">Stop</button>');
    const stop = form.querySelector('[data-testid="stop-button"]');
    stop.addEventListener('click', () => { document.body.dataset.stopped = 'true'; stop.remove(); });
    // What was said last (a whole conversation is sent again after a stopped reply), without the reminder that ends it.
    if (submitted.split('[user]\\n').pop().trim().startsWith('keep this request running')) return;
    const answer = () => {
      document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(layout === 'legacy'
        ? '<article><div data-message-author-role="assistant"><div class="markdown">Hello from hidden ChatGPT</div></div><button data-testid="copy-turn-action-button">Copy</button></article>'
        : `<section data-turn-key="current-turn"><div data-content-search-unit-key="prompt:user"><div data-user-message-bubble>Do not return this user prompt</div><div class="turn-action-controls"><button aria-label="Copy response">Copy response</button></div></div><div ${layout === 'marked-only' ? '' : 'data-conversation-role="assistant"'} ${layout === 'mixed' ? 'data-message-author-role="assistant"' : ''}><div class="result-thinking">Thought for 2s</div><div data-markdown-text-style="assistant-message" ${layout === 'mixed' ? 'class="markdown"' : ''}>Hello from hidden ChatGPT</div></div><div class="turn-action-controls"><button aria-label="Kopieren">Kopieren</button></div></section>`) });
      document.body.insertAdjacentHTML('beforeend', '<div hidden data-conversation-role="assistant"><div data-markdown-text-style="assistant-message">Hidden stale reply</div></div>');
      stop.remove();
    };
    ${layout === 'revised' ? `
    document.body.insertAdjacentHTML('beforeend', '<section id="revising-turn" data-turn-key="revising-turn"><div data-conversation-role="assistant"><div data-markdown-text-style="assistant-message">Hello temporary from hidden</div></div></section>');
    setTimeout(() => { document.querySelector('#revising-turn [data-markdown-text-style]').innerHTML = 'Hello <strong>from hidden</strong>'; document.body.dataset.revised = 'true'; }, 600);
    setTimeout(() => { document.getElementById('revising-turn').remove(); }, 1200);
    setTimeout(answer, 1800);` : layout === 'paused' ? `
    setTimeout(() => {
      document.body.insertAdjacentHTML('beforeend', '<section id="paused-turn" data-turn-key="paused-turn" aria-busy="true"><div class="turn-action-controls"><button data-testid="copy-turn-action-button">Earlier step</button></div><div data-conversation-role="assistant"><div data-markdown-text-style="assistant-message">Hello from hidden</div></div><div class="pending-controls turn-action-controls"><button aria-label="Kopieren">Pending controls</button></div><div data-content-search-unit-key="late:user"><div class="turn-action-controls"><button aria-label="Copy response">User controls</button></div></div><div style="opacity:0"><div class="turn-action-controls"><button aria-label="Kopieren">Hidden controls</button></div></div></section>');
      stop.remove();
      setTimeout(() => { document.querySelector('.pending-controls').remove(); document.getElementById('paused-turn').removeAttribute('aria-busy'); document.body.dataset.paused = 'true'; }, 400);
      setTimeout(() => { document.getElementById('paused-turn').remove(); answer(); }, 2000);
    }, 400);` : fast ? 'answer();' : 'setTimeout(answer, 400);'}
  });
}, 350);
</script>`;

const cases: { legacy: boolean; layout: ReplyLayout; fast: boolean }[] = [
  { legacy: false, layout: 'current', fast: false },
  { legacy: true, layout: 'legacy', fast: false },
  { legacy: false, layout: 'marked-only', fast: true },
  { legacy: false, layout: 'mixed', fast: true },
  { legacy: false, layout: 'paused', fast: false },
  { legacy: false, layout: 'revised', fast: false },
];
for (const { legacy, layout, fast } of cases) {
  test(`ChatGPT Chat reads ${layout} replies with the ${legacy ? 'textarea' : 'hydrated editor'}${fast ? ' even without observing Stop' : ''}`, async () => {
  const configDir = await tempConfigDir({ providers: [{ id: 'browser', type: 'chatgpt-chat', name: 'ChatGPT Chat', baseUrl: 'https://chatgpt.com', enabled: true, headers: {} }] });
  const app = await launchDesktop(configDir);
  try {
    await app.evaluate(({ session }, html) => {
      const submissions: string[] = [];
      (globalThis as { chatSubmissions?: string[] }).chatSubmissions = submissions;
      session.fromPartition('persist:atelier-chatgpt-chat').protocol.handle('https', async (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/api/auth/session') return Response.json({ accessToken: 'test-session' });
        if (path === '/__atelier_test/submitted') { submissions.push(await request.text()); return new Response('ok'); }
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      });
    }, fixture(legacy, layout, fast));
    const page = await app.firstWindow();
    await setUpLocal(page);
    const input = page.getByRole('textbox', { name: 'Message' });
    await input.fill('hello from the actual composer');
    // The provider reads its models from the page when it first loads, and a message sent before that isn't taken:
    // like a person, press again until it goes.
    await expect(async () => {
      await input.press('Enter');
      await expect(input).toHaveText('', { timeout: 1500 });
    }).toPass({ timeout: 20_000 });
    if (layout === 'revised') {
      await expect(page.getByText('Hello temporary from hidden', { exact: true })).toBeVisible();
      await expect(page.getByText('Hello from hidden', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(1);
    }
    if (layout === 'paused') {
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('https://chatgpt.com'))!.webContents.executeJavaScript('document.body.dataset.paused'))).toBe('true');
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(1);
    }
    await expect(page.getByText('Hello from hidden ChatGPT', { exact: true }).last()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(page.getByText('Do not return this user prompt', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Hidden stale reply', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Thought for 2s', { exact: true })).toHaveCount(0);
    if (layout === 'revised') {
      await page.reload();
      await expect(page.getByText('Hello from hidden ChatGPT', { exact: true })).toHaveCount(1);
      await expect(page.getByText('Hello temporary from hidden', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Hello from hidden', { exact: true })).toHaveCount(0);
    }
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().startsWith('https://chatgpt.com')).map(win => ({ visible: win.isVisible() })));
    expect(windows).toEqual([{ visible: false }]);
    const submissions = () => app.evaluate(() => (globalThis as { chatSubmissions?: string[] }).chatSubmissions ?? []);
    await expect.poll(submissions).toHaveLength(1);
    expect((await submissions())[0]).toContain('hello from the actual composer');
    expect((await submissions())[0]).not.toContain('First message:');
    if (!legacy) {
      expect((await submissions())[0]).toContain('\n\n');
      const oldSelector = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('https://chatgpt.com'))!.webContents.executeJavaScript(`document.querySelector('[contenteditable]').closest('form').querySelector('button[data-testid="send-button"], button[aria-label*="Send" i], button[type="submit"]') !== null`));
      expect(oldSelector).toBe(false);
    }

    const chatPage = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('https://chatgpt.com'))!.webContents.executeJavaScript('window.pageLoadId'));
    const loaded = await chatPage();
    await input.fill('and hello again');
    await input.press('Enter');
    await expect(page.getByText('Hello from hidden ChatGPT', { exact: true })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect.poll(submissions).toHaveLength(2);
    // The second message goes into the same ChatGPT conversation, and only what is new is typed.
    expect(await chatPage()).toBe(loaded);
    expect((await submissions())[1]).toContain('and hello again');
    expect((await submissions())[1]).not.toContain('hello from the actual composer');

    await input.fill('keep this request running');
    await input.press('Enter');
    await expect.poll(submissions).toHaveLength(3);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('https://chatgpt.com'))!.webContents.executeJavaScript('document.body.dataset.stopped'))).toBe('true');

    await input.fill('reply after stopping');
    await input.press('Enter');
    await expect(page.getByText('Hello from hidden ChatGPT', { exact: true })).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect.poll(submissions).toHaveLength(4);
    // A stopped reply leaves the page's conversation unfinished, so the next message starts a new chat with everything said so far.
    expect((await submissions())[3]).toContain('hello from the actual composer');
    expect((await submissions())[3]).toContain('and hello again');
    expect(await chatPage()).not.toBe(loaded);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('https://chatgpt.com'))!.isVisible())).toBe(false);
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
  });
}
