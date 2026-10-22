import { render, screen } from '@testing-library/react';
import { Pin } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Badge } from './badge.tsx';
import { DiffStat, formatCount } from './diff-stat.tsx';
import { Icon } from './icon.tsx';
import { Kbd } from './kbd.tsx';
import { Spinner } from './spinner.tsx';
import { ThinkingDots } from './thinking-dots.tsx';

describe('DiffStat', () => {
  it('formats counts with thousands separators', () => {
    expect(formatCount(4143)).toBe('4,143');
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(0)).toBe('0');
  });

  it('renders the added and removed pair on the diff tints', () => {
    render(<DiffStat added={4143} removed={250} />);
    const added = screen.getByText('+4,143');
    const removed = screen.getByText('−250');
    expect(added.className.split(' ')).toEqual(
      expect.arrayContaining(['bg-diff-added-bg', 'text-diff-added-text', 'rounded-[4px]', 'px-1']),
    );
    expect(removed.className.split(' ')).toEqual(expect.arrayContaining(['bg-diff-removed-bg', 'text-diff-removed-text']));
    expect(added.parentElement?.className).toContain('font-mono');
    expect(added.parentElement?.className).toContain('text-[12px]/[18px]');
  });

  it('gives assistive tech a readable summary', () => {
    render(<DiffStat added={12} removed={1500} />);
    expect(screen.getByText('12 lines added, 1,500 lines removed').className).toBe('sr-only');
    expect(screen.getByText('+12').getAttribute('aria-hidden')).toBe('true');
  });

  it('says “line” for one', () => {
    render(<DiffStat added={1} removed={0} />);
    expect(screen.getByText('1 line added, 0 lines removed')).toBeTruthy();
  });
});

describe('Badge', () => {
  it('is 18 tall with badge text on the neutral fill by default', () => {
    render(<Badge>Project</Badge>);
    expect(screen.getByText('Project').className.split(' ')).toEqual(
      expect.arrayContaining(['h-[18px]', 'px-1.5', 'rounded-xs', 'text-badge', 'bg-badge-bg', 'text-fg-secondary']),
    );
  });

  it.each([
    ['accent', 'bg-interactive-subtle', 'text-interactive-text'],
    ['success', 'bg-success-subtle', 'text-success-text'],
    ['warning', 'bg-warning-subtle', 'text-warning-text'],
    ['danger', 'bg-danger-subtle', 'text-danger-text'],
  ] as const)('tints the %s tone', (tone, bg, text) => {
    render(<Badge tone={tone}>Tone</Badge>);
    const classes = screen.getByText('Tone').className.split(' ');
    expect(classes).toContain(bg);
    expect(classes).toContain(text);
  });
});

describe('Kbd', () => {
  it('renders a muted key cap with a currentColor ring', () => {
    render(<Kbd>⌘K</Kbd>);
    const key = screen.getByText('⌘K');
    expect(key.tagName).toBe('KBD');
    expect(key.className).toContain('text-fg-muted');
    expect(key.className).toContain('h-[18px]');
    expect(key.className).toContain('color-mix(in_srgb,currentColor_22%,transparent)');
  });
});

describe('Icon', () => {
  it('is decorative by default with a 1.5 stroke', () => {
    const { container } = render(<Icon icon={Pin} size="md" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('stroke-width')).toBe('1.5');
  });

  it('is an image when labelled', () => {
    render(<Icon icon={Pin} label="Pinned" />);
    expect(screen.getByRole('img', { name: 'Pinned' }).getAttribute('width')).toBe('16');
  });
});

describe('Spinner and ThinkingDots', () => {
  it('spinner spins unless motion is reduced', () => {
    render(<Spinner label="Loading" />);
    const spinner = screen.getByRole('status', { name: 'Loading' });
    const classes = spinner.getAttribute('class') ?? '';
    expect(classes).toContain('animate-spin');
    expect(classes).toContain('motion-reduce:animate-none');
  });

  it('thinking dots are three clay dots pulsing in sequence', () => {
    const { container } = render(<ThinkingDots />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.className).toContain('size-3.5');
    const dots = Array.from(box.children) as HTMLElement[];
    expect(dots).toHaveLength(3);
    dots.forEach((dot) => {
      expect(dot.className).toContain('bg-brand-mark');
      expect(dot.className).toContain('size-[3px]');
      expect(dot.className).toContain('motion-reduce:animate-none');
      expect(dot.className).toContain('[:root[data-motion=reduced]_&]:animate-none');
    });
    expect(dots.map((dot) => dot.style.animationDelay)).toEqual(['0ms', '150ms', '300ms']);
  });

  it('thinking dots can carry a label', () => {
    render(<ThinkingDots label="Thinking" />);
    expect(screen.getByRole('img', { name: 'Thinking' })).toBeTruthy();
  });
});
