// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKDOWN_SCRIPT } from './chatgpt-markdown.ts';

const toMarkdown = new Function(`${MARKDOWN_SCRIPT}; return toMarkdown;`)() as (root: Element) => string;
const convert = (html: string) => {
  document.body.innerHTML = `<div class="markdown prose" id="answer">${html}</div>`;
  return toMarkdown(document.getElementById('answer')!);
};

describe('toMarkdown', () => {
  it('keeps paragraphs, emphasis, inline code and hard breaks', () => {
    expect(convert('<p>Use <strong>two</strong> and <em>one</em> and <code>x_y</code>.<br>Next line</p><p>Second</p>'))
      .toBe('Use **two** and *one* and `x_y`.  \nNext line\n\nSecond');
  });

  it('moves spaces out of emphasis markers', () => {
    expect(convert('<p>a<strong> bold </strong>b</p>')).toBe('a **bold** b');
  });

  it('writes headings with the right level', () => {
    expect(convert('<h2>Pick one</h2><h4>Then</h4>')).toBe('## Pick one\n\n#### Then');
  });

  it('writes bullets, numbers (with their start) and nested lists', () => {
    expect(convert('<ul><li>One</li><li>Two<ul><li>Inner</li></ul></li></ul><ol start="3"><li>Three</li><li>Four</li></ol>'))
      .toBe('- One\n- Two\n  - Inner\n\n3. Three\n4. Four');
  });

  it('keeps loose list items apart and indents their continuation', () => {
    expect(convert('<ol><li><p>First</p><p>More about it</p></li><li><p>Second</p></li></ol>'))
      .toBe('1. First\n\n   More about it\n\n2. Second');
  });

  it('writes task list items', () => {
    expect(convert('<ul><li><input type="checkbox" checked disabled> Done</li><li><input type="checkbox" disabled> Open</li></ul>'))
      .toBe('- [x] Done\n- [ ] Open');
  });

  it('turns a table into GFM with its alignment, and escapes pipes in cells', () => {
    expect(convert('<div class="overflow-x-auto"><table><thead><tr><th style="text-align:left">Simulator</th><th style="text-align:right">Cost</th></tr></thead><tbody><tr><td>iRacing</td><td>a | b</td></tr><tr><td>AC</td></tr></tbody></table></div>'))
      .toBe('| Simulator | Cost |\n| :--- | ---: |\n| iRacing | a \\| b |\n| AC |  |');
  });

  it('keeps a code block as a fence with its language, without the page controls', () => {
    const html = '<pre class="overflow-visible!"><div class="contain-inline-size"><div class="flex items-center text-xs select-none">python<div><button aria-label="Copy">Copy code</button></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! language-python"><span class="hljs-keyword">def</span> f():\n    <span class="hljs-keyword">return</span> <span class="hljs-number">1</span>\n</code></div></div></pre>';
    expect(convert(html)).toBe('```python\ndef f():\n    return 1\n```');
  });

  it('reads a CodeMirror code block line by line', () => {
    const html = '<pre><div><div class="sticky select-none">bash<button>Copy</button></div><div class="cm-editor"><div class="cm-scroller"><div class="cm-content"><div class="cm-line">npm install</div><div class="cm-line">npm test</div></div></div></div></div></pre>';
    expect(convert(html)).toBe('```\nnpm install\nnpm test\n```');
  });

  it('uses a longer fence when the code holds one', () => {
    expect(convert('<pre><code>```js\nx\n```</code></pre>')).toBe('````\n```js\nx\n```\n````');
  });

  it('writes a link, drops ChatGPT tracking from it, and shows a source chip as a link instead of stray text', () => {
    expect(convert('<p>Rookie licenses<span data-testid="webpage-citation-pill" class="ms-1 inline-flex"><a href="https://www.iracing.com/getting-started/?utm_source=chatgpt.com" target="_blank" rel="noopener"><span>iRacing</span></a></span> start there. See <a href="https://example.com/a_(b)">docs</a>.</p>'))
      .toBe('Rookie licenses[iRacing](https://www.iracing.com/getting-started/) start there. See [docs](https://example.com/a_%28b%29).');
  });

  it('leaves an address the page linked to itself as plain text, so a tool call that holds a URL still parses', () => {
    expect(convert('<p>{"url": "<a href="https://example.com/a_(b)?q=1">https://example.com/a_(b)?q=1</a>", "to": "<a href="mailto:me@example.com">me@example.com</a>"}</p>'))
      .toBe('{"url": "https://example.com/a_(b)?q=1", "to": "me@example.com"}');
  });

  it('does not make a link of a script address', () => {
    expect(convert('<p><a href="javascript:alert(1)">click</a></p>')).toBe('click');
  });

  it('writes a block quote and a rule', () => {
    expect(convert('<blockquote><p>Quoted</p><p>Again</p></blockquote><hr><p>After</p>')).toBe('> Quoted\n>\n> Again\n\n---\n\nAfter');
  });

  it('reads math once, from its TeX source, not from the twin MathML and HTML', () => {
    const katex = (source: string) => `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${source}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span>x</span></span></span>`;
    expect(convert(`<p>Let ${katex('x^2')} be big.</p><div class="katex-display">${katex('\\frac{a}{b}')}</div>`))
      .toBe('Let $x^2$ be big.\n\n$$\n\\frac{a}{b}\n$$');
  });

  it('keeps text exactly as the page shows it, so that a tool call written in the reply still parses', () => {
    const call = '<tool_call>{"name": "Read", "arguments": {"paths": ["src/a_b.ts", "src/[id]/page.tsx"], "pattern": "*.ts", "note": "line1\\nline2"}}</tool_call>';
    expect(convert(`<p>${call.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)).toBe(call);
    expect(convert('<p>2 * 3 [a] snake_case</p><p>- plain</p>')).toBe('2 * 3 [a] snake_case\n\n- plain');
  });

  it('leaves out buttons, icons and hidden parts', () => {
    expect(convert('<p>Text<button>Copy</button><svg><text>icon</text></svg><span hidden>secret</span><span aria-hidden="true">decor</span></p>')).toBe('Text');
  });

  it('keeps text that sits outside any paragraph, next to blocks', () => {
    expect(convert('Intro<ul><li>One</li></ul>Outro')).toBe('Intro\n\n- One\n\nOutro');
  });

  it('is empty for an empty answer', () => {
    expect(convert('<p><br></p>')).toBe('');
  });

  // Answers as chatgpt.com rendered them on 2026-10-20 (see __fixtures__/chatgpt-live), whose markup differs from plain HTML:
  // a code block is a div with its language in a header, inline code and math are spans, and the page's own controls
  // carry data-markdown-copy="exclude".
  describe('the answer as the page renders it', () => {
    const live = (name: string) => {
      document.body.innerHTML = readFileSync(join(import.meta.dirname, '__fixtures__/chatgpt-live', `${name}.html`), 'utf8');
      return toMarkdown(document.querySelector('[data-markdown-text-style="assistant-message"]')!);
    };

    it('reads headings, emphasis, inline code, lists, a table, a code block, a quote and a link', () => {
      expect(live('format')).toBe([
        '## Demo',
        'This sentence includes **bold text**, *italic text*, and `inline code`.',
        '- First item\n- Second item\n  - Nested sub-bullet\n- Third item',
        '1. First numbered item\n2. Second numbered item',
        '| Name | Value |\n| --- | --- |\n| Alpha | 10 |\n| Beta | 20 |\n| Gamma | 30 |',
        '```python\nx = 10\ny = 20\nprint(x + y)\n```',
        '> This is an example of a blockquote.',
        '[Example](https://example.com)',
      ].join('\n\n'));
    });

    it('writes a source chip as a link without its favicon, its "+1" or ChatGPT tracking', () => {
      expect(live('web')).toBe('As of October 20, 2026, the latest Node.js LTS release line is **Node.js 24.x (Krypton)**, with **v24.22.0** being the latest LTS version; Node.js 26.x remains in the Current release phase. [Node.js](https://nodejs.org/en/download)');
    });

    it('keeps TeX as TeX, from the page\'s own copy of the source', () => {
      expect(live('math')).toBe('$\\displaystyle x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$  \nThe Pythagorean theorem is $x^2 + y^2 = z^2$.');
    });
  });
});
