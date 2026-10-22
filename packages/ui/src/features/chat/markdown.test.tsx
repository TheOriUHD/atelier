import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { displayMathLines, Markdown } from './markdown.tsx';
import { RunInTerminal, isShellLanguage } from './run-in-terminal.ts';

const openExternal = vi.fn();
vi.mock('../../lib/platform.ts', () => ({ openExternal: (url: string) => openExternal(url) }));

describe('displayMathLines', () => {
  it('turns a one-line $$…$$ into display math, but not inside code fences', () => {
    expect(displayMathLines('Text\n$$a^2 + b^2$$\nmore')).toBe('Text\n$$\na^2 + b^2\n$$\nmore');
    expect(displayMathLines('```tex\n$$a$$\n```')).toBe('```tex\n$$a$$\n```');
    expect(displayMathLines('costs $$5 and $$6')).toBe('costs $$5 and $$6');
  });
});

describe('Markdown', () => {
  it('renders blocks with our components instead of the shadcn defaults', () => {
    const { container } = render(
      <Markdown
        streaming={false}
        text={
          '### Title\n\nUse `npm` and [docs](https://example.com).\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```'
        }
      />,
    );
    expect(container.firstElementChild!.className).toContain('atelier-prose');
    expect(screen.getByText('Title').tagName).toBe('H3');
    expect(screen.getByText('npm').className).toContain('bg-code-inline-background');

    const table = container.querySelector('table')!;
    expect(table.parentElement!.className).toContain('rounded-md');
    expect(table.parentElement!.hasAttribute('data-prose-block')).toBe(true);

    const code = container.querySelector('pre')!;
    expect(code.textContent).toBe('const a = 1;');
    expect(code.closest('[data-prose-block]')!.textContent).toContain('ts');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();

    fireEvent.click(screen.getByText('docs'));
    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('keeps dollar amounts as text, so the bold around them still renders, and still typesets real math', async () => {
    const text = '**Apple HomeView ($299)** is a new hub; **HomePod mini 2 ($149)** and Apple TV 4K ($299, also $59.95) follow. Inline $x^2$ is math.';
    const { container } = render(<Markdown streaming={false} text={text} />);
    // The amounts stay text; only the real formula is typeset (KaTeX renders one `.katex` element per formula, a moment later).
    await waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(1));
    expect(container.textContent).toContain('Apple HomeView ($299)');
    expect(container.textContent).toContain('($149)');
    expect(container.textContent).not.toContain('**');
    expect([...container.querySelectorAll('strong')].map((e) => e.textContent)).toEqual(['Apple HomeView ($299)', 'HomePod mini 2 ($149)']);
  });

  it("shows Atelier's tags the model quoted escaped as they were, as text, and a file as it is", () => {
    const text = 'The page says ‹project name="x"> and ‹/context-update>, see `‹env>`.\n\n```\n‹/document>\n```';
    const { container, unmount } = render(<Markdown streaming={false} text={text} />);
    expect(container.querySelector('p')!.textContent).toBe('The page says <project name="x"> and </context-update>, see <env>.');
    expect(container.querySelector('pre')!.textContent).toBe('</document>');
    expect(container.querySelector('project')).toBeNull();
    unmount();
    const file = render(<Markdown streaming={false} text="A file with ‹env> in it." verbatim />);
    expect(file.container.querySelector('p')!.textContent).toBe('A file with ‹env> in it.');
  });
});

describe('Run in terminal', () => {
  const block = (language: string, run: ((command: string) => void) | null, streaming = false) =>
    render(
      <RunInTerminal.Provider value={run}>
        <Markdown streaming={streaming} text={`\`\`\`${language}\npip install rich\npython3 demo.py\n\`\`\``} />
      </RunInTerminal.Provider>,
    );

  it('sits next to Copy on a shell block, where a terminal is available, and sends the whole block', () => {
    const run = vi.fn();
    block('bash', run);
    fireEvent.click(screen.getByRole('button', { name: 'Run in terminal' }));
    expect(run).toHaveBeenCalledWith('pip install rich\npython3 demo.py');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });

  it('is left out of other languages, without a terminal and while the block still streams', () => {
    const { unmount } = block('python', vi.fn());
    expect(screen.queryByRole('button', { name: 'Run in terminal' })).toBeNull();
    unmount();
    const none = block('bash', null);
    expect(screen.queryByRole('button', { name: 'Run in terminal' })).toBeNull();
    none.unmount();
    // An open fence is still being written; a closed one is whole even while the message streams.
    const run = vi.fn();
    render(
      <RunInTerminal.Provider value={run}>
        <Markdown streaming text={'```bash\npip install ri'} />
      </RunInTerminal.Provider>,
    );
    expect(screen.queryByRole('button', { name: 'Run in terminal' })).toBeNull();
  });

  it('knows the shell languages', () => {
    for (const l of ['bash', 'sh', 'zsh', 'shell', 'Bash']) expect(isShellLanguage(l), l).toBe(true);
    for (const l of ['python', 'ts', 'json', '']) expect(isShellLanguage(l), l).toBe(false);
  });
});

describe('Markdown images', () => {
  it('open bigger in the lightbox', async () => {
    render(<Markdown streaming={false} text={'See ![A chart](https://example.com/chart.png) here.'} />);
    const button = screen.getByRole('button', { name: 'A chart' });
    expect(button.className).toContain('cursor-zoom-in');
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Image' });
    expect(dialog.querySelector('img')!.getAttribute('src')).toBe('https://example.com/chart.png');
  });
});
