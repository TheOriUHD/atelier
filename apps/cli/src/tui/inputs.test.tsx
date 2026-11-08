import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Paint, palette } from '../style.ts';
import { Choices, FilterList, Form, type Choice } from './inputs.tsx';

const paint = new Paint(palette('dark', 0));
const wait = () => new Promise((r) => setTimeout(r, 30));
const DOWN = '\x1b[B';
const TAB = '\t';

describe('choices', () => {
  it('wraps a hint under its label, not back at the edge', () => {
    const ui = render(
      <Box width={34}>
        <Choices paint={paint} showHints="all" choices={[{ value: 'a', label: 'Auto', hint: 'A reviewing model lets through what you asked for and asks you about the rest.' }]} onPick={() => undefined} />
      </Box>,
    );
    const lines = ui.lastFrame()!.split('\n');
    expect(lines[0]).toContain('Auto');
    // Every line of the hint starts at the hint's indent.
    expect(lines.slice(1).every((l) => l.startsWith('     ') && l.trim().length > 0)).toBe(true);
    expect(lines.length).toBeGreaterThan(2);
  });

  it('starts on the first row while a list fills in, and keeps the row picked once moved', async () => {
    let setList: (c: Choice<string>[]) => void = () => undefined;
    const picked: string[] = [];
    function List() {
      const [choices, set] = useState<Choice<string>[]>([
        { value: 'other', label: 'Another server…' },
        { value: 'local', label: 'Only this computer' },
      ]);
      setList = set;
      return <Choices paint={paint} choices={choices} onPick={(v) => picked.push(v)} />;
    }
    const ui = render(<List />);
    setList([{ value: 'home', label: 'atelier.home' }, { value: 'other', label: 'Another server…' }, { value: 'local', label: 'Only this computer' }]);
    await wait();
    expect(ui.lastFrame()).toContain('› 1. atelier.home');
    ui.stdin.write(DOWN);
    ui.stdin.write(DOWN);
    await wait();
    // A server found later goes in above: the cursor stays on "Only this computer".
    setList([{ value: 'home', label: 'atelier.home' }, { value: 'lab', label: 'lab.local' }, { value: 'other', label: 'Another server…' }, { value: 'local', label: 'Only this computer' }]);
    await wait();
    expect(ui.lastFrame()).toContain('› 4. Only this computer');
    ui.stdin.write('\r');
    await wait();
    expect(picked).toEqual(['local']);
  });

  it('switches a checkbox with space', async () => {
    const toggled: string[] = [];
    const ui = render(<Choices paint={paint} choices={[{ value: 'scratch', label: '[✓] New empty folders' }]} onToggle={(v) => toggled.push(v)} onPick={() => undefined} />);
    ui.stdin.write(' ');
    await wait();
    expect(toggled).toEqual(['scratch']);
  });
});

describe('a form', () => {
  it('shows every field at once, goes on with Enter or Tab and sends from the last', async () => {
    const sent: Record<string, string>[] = [];
    const ui = render(
      <Form
        paint={paint}
        fields={[
          { name: 'username', label: 'Username' },
          { name: 'password', label: 'Password', mask: true },
        ]}
        onSubmit={(v) => sent.push(v)}
        onCancel={() => undefined}
      />,
    );
    expect(ui.lastFrame()).toContain('Username');
    expect(ui.lastFrame()).toContain('Password');
    ui.stdin.write('ada');
    await wait();
    ui.stdin.write('\r');
    await wait();
    ui.stdin.write('secret-password');
    await wait();
    expect(ui.lastFrame()).toContain('•••••••••••••••');
    expect(ui.lastFrame()).not.toContain('secret');
    ui.stdin.write('\r');
    await wait();
    expect(sent).toEqual([{ username: 'ada', password: 'secret-password' }]);
  });

  it('starts on the first empty field, and reaches the extra row with Tab', async () => {
    let extra = 0;
    const ui = render(
      <Form
        paint={paint}
        fields={[
          { name: 'username', label: 'Username', initial: 'ada' },
          { name: 'password', label: 'Password', mask: true },
        ]}
        extra={{ label: 'I have an invite code instead', onPick: () => extra++ }}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(ui.lastFrame()).toMatch(/Password\s+›/);
    ui.stdin.write(TAB);
    await wait();
    expect(ui.lastFrame()).toContain('› I have an invite code instead');
    ui.stdin.write('\r');
    await wait();
    expect(extra).toBe(1);
  });
});

describe('a long list', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ value: `m${i}`, label: `Model ${i} with a rather long name that goes on and on and on`, group: i < 15 ? 'openai' : 'mistral' }));

  it('keeps one line a row and the same height while it scrolls', async () => {
    const ui = render(
      <Box width={40}>
        <FilterList paint={paint} items={items} rows={6} onPick={() => undefined} />
      </Box>,
    );
    const height = ui.lastFrame()!.split('\n').length;
    for (let i = 0; i < 20; i++) ui.stdin.write(DOWN);
    await wait();
    const frame = ui.lastFrame()!;
    expect(frame.split('\n').length).toBe(height);
    expect(frame.split('\n').every((l) => [...l].length <= 40)).toBe(true);
    expect(frame).toContain('› Model 20');
    expect(frame).toContain('21 of 30');
  });

  it('filters as you type and picks with Enter', async () => {
    const picked: string[] = [];
    const ui = render(<FilterList paint={paint} items={items} rows={6} onPick={(v) => picked.push(v)} />);
    ui.stdin.write('Model 2');
    await wait();
    expect(ui.lastFrame()).toContain('/ Model 2');
    ui.stdin.write('7');
    await wait();
    ui.stdin.write('\r');
    await wait();
    expect(picked).toEqual(['m27']);
  });
});
