/**
 * Drives the real ChatGPT Chat driver (src/chatgpt-chat.ts) against chatgpt.com, in a profile of its own, to check what the
 * page really does: the fixtures in src/__fixtures__/chatgpt-live and the selectors in chatgpt-markdown.ts / chatgpt-chat.ts
 * come from here, and ChatGPT changes its markup. Run it with `node scripts/chatgpt-live/run.mjs [scenarios]`
 * (scenarios, comma separated: format, repeat, tool, chain, stop, web, math; default all of format/web/math). The first
 * run shows a window to sign in to ChatGPT (the profile is kept in LIVE_DIR, which holds your sign-in: delete it after);
 * each scenario prints the Markdown it got and saves the answer's HTML as capture-<name>.html in LIVE_DIR. It sends a few
 * short messages from your account, as temporary chats.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron's main process, loaded as CommonJS */
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');
const DIR = process.env.LIVE_DIR || __dirname;
app.setPath('userData', path.join(DIR, 'profile'));
const { ChatGptChatBrowser } = require(path.join(DIR, 'chatgpt-chat.cjs'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = (process.env.SCENARIOS || 'all').split(',');

app.whenReady().then(async () => {
  const b = new ChatGptChatBrowser();
  const page = (script) => b.window.webContents.executeJavaScript(script);
  const status = async () => JSON.parse(await b.request('status')).signedIn;
  if (!(await status())) {
    log('NEEDS_SIGNIN');
    await b.request('open');
    for (let i = 0; i < 300 && !(await status()); i++) await sleep(2000);
    if (!(await status())) { log('SIGNIN_TIMEOUT'); app.exit(2); return; }
    await b.request('hide');
  }
  log('SIGNED_IN');
  let n = 0;
  async function capture(label) {
    const html = await page(`(() => { const m = [...document.querySelectorAll('[data-message-author-role="assistant"], [data-conversation-role="assistant"]')]; const last = m.at(-1); const turn = last?.closest('[data-turn-key], article, [data-testid^="conversation-turn-"]') || last; return turn ? turn.outerHTML : ''; })()`);
    fs.writeFileSync(path.join(DIR, `capture-${label}.html`), html);
    return html.length;
  }
  async function ask(label, prompt, more = {}) {
    const id = `live-${++n}`;
    const t0 = Date.now();
    await b.request('start', JSON.stringify({ id, prompt, token: id, temporary: true, ...more }));
    const sentMs = Date.now() - t0;
    let text = ''; let first = null; let done = false; let error = null;
    while (!done && Date.now() - t0 < 300000) {
      const st = JSON.parse(await b.request('poll', id));
      if (st.error) { error = st.error; break; }
      if (st.text && st.text !== text) { first ??= Date.now() - t0; text = st.text; }
      done = st.done;
      if (!done) await sleep(250);
    }
    const size = await capture(label);
    const url = await page('location.href');
    await b.request('stop', id);
    log(`--- ${label}: sent after ${sentMs} ms, first text ${first} ms, done ${done} after ${Date.now() - t0} ms, error=${error}, url=${url}, html=${size}`);
    console.log(text);
    console.log(`--- end ${label}`);
    return { id, text, done };
  }
  try {
    let first;
    if (only.includes('all') || only.includes('format')) {
      first = await ask('format', "Reply with exactly this structure and nothing else: a level-2 heading 'Demo'; one sentence with **bold**, *italic* and `inline code`; a bulleted list of 3 items where item 2 has a nested sub-bullet; a numbered list of 2 items; a table with columns Name and Value and 3 rows; a python code block of 3 lines; a blockquote; and a link to https://example.com labelled Example.");
      log('temp-chat indicators:', JSON.stringify(await page(`({ search: location.search, title: document.title, label: /Temporary/i.test(document.body.innerText) })`)));
      await page('window.__probe = 12345');
      if (first.done) {
        await ask('continue', 'Now repeat only the python code block, then the word DONE.', { parent: first.id, delta: '[user]\nNow repeat only the python code block, then the word DONE.' });
        log('same page after continue:', await page('window.__probe === 12345'));
      }
    }
    if (only.includes('repeat')) {
      for (let i = 1; i <= 3; i++) {
        const r = await ask('repeat' + i, "Reply with exactly: a short paragraph, then a bulleted list of 2 items, then a python code block of 2 lines, then a final paragraph that is only a link to https://example.org labelled Last.");
        log('ends with Last link:', /\[Last\]\(https:\/\/example\.org\/?\)\s*$/.test(r.text));
      }
    }
    if (only.includes('tool')) {
      const call = '<tool_call>{"name": "Read", "arguments": {"paths": ["src/a_b.ts", "src/[id]/page.tsx"], "pattern": "*.ts", "note": "line1\\nline2", "html": "<b>x</b> & y"}}</tool_call>';
      const r = await ask('tool', 'You can call tools by writing a call exactly in this format and nothing else after it. Reply with exactly this text and nothing else:\n\n' + call);
      log('tool call preserved exactly:', r.text.trim() === call, '| expected:', call);
    }
    if (only.includes('chain')) {
      let prev = await ask('chain1', 'Remember the number 417. Reply only: OK.');
      for (let i = 2; i <= 3; i++) {
        const d = i === 2 ? 'Add 100 to the number I told you. Reply with the result only.' : 'Now multiply that result by 2. Reply with the result only.';
        prev = await ask('chain' + i, 'ignored full', { parent: prev.id, delta: '[user]\n' + d });
      }
    }
    if (only.includes('stop')) {
      const id = 'live-stop';
      await b.request('start', JSON.stringify({ id, prompt: 'Write a very long story of at least 1500 words about a lighthouse keeper.', token: id, temporary: true }));
      let got = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 12000) { const st = JSON.parse(await b.request('poll', id)); got = st.text.length; await sleep(250); }
      const t1 = Date.now();
      await b.request('stop', id);
      log('stopped after', got, 'chars; stop took', Date.now() - t1, 'ms; generating now:', await page(`!!document.querySelector('[data-testid="stop-button"], button[aria-label="Stop streaming" i]')`));
      const r = await ask('after-stop', 'Reply with only the word PONG.');
      log('after stop ok:', r.text.trim());
    }
    if (only.includes('all') || only.includes('web')) await ask('web', 'Using a web search, what is the latest Node.js LTS release line? One sentence, with sources.');
    if (only.includes('all') || only.includes('math')) await ask('math', 'Show the quadratic formula as display LaTeX math, then mention x^2 + y^2 = z^2 inline as math. Two lines only.');
  } catch (error) {
    log('HARNESS_ERROR', error && error.stack || error);
  }
  if (only.includes('repl')) {
    // Stays signed in and runs commands: write the body of an async function to LIVE_DIR/cmd.js (it sees b, page, sleep, ask,
    // fs, path, electron, win) and read what it returns from LIVE_DIR/out.txt. Delete LIVE_DIR/stop to end.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    fs.writeFileSync(path.join(DIR, 'stop'), '');
    log('REPL_READY');
    while (fs.existsSync(path.join(DIR, 'stop'))) {
      const file = path.join(DIR, 'cmd.js');
      if (fs.existsSync(file)) {
        const body = fs.readFileSync(file, 'utf8');
        fs.rmSync(file);
        let out;
        try { out = await new AsyncFunction('b', 'page', 'sleep', 'ask', 'fs', 'path', 'electron', 'win', 'load', body)(b, page, sleep, ask, fs, path, require('electron'), b.window, require); }
        catch (error) { out = 'ERROR ' + (error && error.stack || error); }
        fs.writeFileSync(path.join(DIR, 'out.tmp'), typeof out === 'string' ? out : JSON.stringify(out, null, 1));
        fs.renameSync(path.join(DIR, 'out.tmp'), path.join(DIR, 'out.txt'));
      }
      await sleep(300);
    }
  }
  log('FINISHED');
  app.exit(0);
});
