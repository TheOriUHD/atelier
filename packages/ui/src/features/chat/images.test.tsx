import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ToolResultPart } from '@atelier/protocol';
import { ToolActivity } from './parts.tsx';
import { toolLabel, viewedImages, ZoomableImage } from './images.tsx';
import type { ActivityStepView } from './turns.ts';

type ToolView = Extract<ActivityStepView, { kind: 'tool' }>;

const read = (n: number, extra: Partial<ToolView> = {}): ToolView => ({
  kind: 'tool',
  key: `m:${n}`,
  call: { type: 'tool_call', id: `c${n}`, name: 'Read', input: { file_path: `/repo/shot-${n}.png` } },
  result: { type: 'tool_result', callId: `c${n}`, content: [{ type: 'text', text: `Image shot-${n}.png` }, { type: 'image', mime: 'image/png', blob: `sha${n}` }] },
  running: false,
  since: 0,
  output: undefined,
  ...extra,
});

const tenReads = () => Array.from({ length: 10 }, (_, i) => read(i + 1));
const blobOf = (img: Element) => /sha\d+/.exec(img.getAttribute('src') ?? '')?.[0];

describe('viewedImages', () => {
  it('collects the images tool results carried, in order, with the tool that produced them', () => {
    const bash: ToolView = { ...read(0), call: { type: 'tool_call', id: 'b', name: 'Bash', input: {} }, result: { type: 'tool_result', callId: 'b', content: [{ type: 'text', text: 'ok' }] } };
    const shot: ToolView = {
      ...read(9),
      call: { type: 'tool_call', id: 's', name: 'mcp__browser__take_screenshot', input: {} },
      result: { type: 'tool_result', callId: 's', content: [{ type: 'image', mime: 'image/png', blob: 'shaS' }] } satisfies ToolResultPart,
    };
    const images = viewedImages([read(1), bash, { kind: 'thinking', key: 't', text: '', active: false }, read(2, { result: undefined, running: true }), shot]);
    expect(images.map((i) => [i.tool, /sha\w+/.exec(i.src)?.[0]])).toEqual([
      ['Read', 'sha1'],
      ['Screenshot', 'shaS'],
    ]);
  });

  it('names connector tools by their own name', () => {
    expect(toolLabel('mcp__files__view_image')).toBe('View image');
    expect(toolLabel('Read')).toBe('Read');
  });
});

describe('Viewed images on an activity line', () => {
  it('shows the last three thumbnails after "+7" for ten images', () => {
    render(<ToolActivity steps={tenReads()} />);
    const group = screen.getByRole('group', { name: 'Images looked at' });
    expect(within(group).getByText('+7')).toBeTruthy();
    const thumbs = within(group).getAllByRole('button');
    expect(thumbs.map((b) => b.getAttribute('aria-label'))).toEqual(['Read image 8 of 10', 'Read image 9 of 10', 'Read image 10 of 10']);
    expect(thumbs.map((b) => blobOf(b.querySelector('img')!))).toEqual(['sha8', 'sha9', 'sha10']);
    expect(thumbs[0]!.className.split(' ')).toEqual(expect.arrayContaining(['h-6', 'w-8', 'rounded-[6px]', 'border', 'cursor-zoom-in']));
    // Same line as the summary.
    expect(group.parentElement!.contains(screen.getByRole('button', { name: /Used Read/ }))).toBe(true);
  });

  it('shows no thumbnails when nothing was looked at', () => {
    render(<ToolActivity steps={[read(1, { result: { type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'hi' }] } })]} />);
    expect(screen.queryByRole('group', { name: 'Images looked at' })).toBeNull();
  });

  it('previews a thumbnail on hover with the tool and its place among all images', async () => {
    render(<ToolActivity steps={tenReads()} />);
    const last = screen.getByRole('button', { name: 'Read image 10 of 10' });
    fireEvent.pointerEnter(last);
    fireEvent.mouseEnter(last);
    const preview = await screen.findByLabelText('Image preview', {}, { timeout: 2000 });
    expect(within(preview).getByText('Read')).toBeTruthy();
    expect(within(preview).getByText('10 of 10')).toBeTruthy();
    expect(blobOf(preview.querySelector('img')!)).toBe('sha10');
  });

  it('opens the lightbox at the clicked thumbnail and steps through all ten', async () => {
    render(<ToolActivity steps={tenReads()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read image 9 of 10' }));
    const dialog = await screen.findByRole('dialog', { name: 'Image' });
    expect(blobOf(dialog.querySelector('img')!)).toBe('sha9');
    expect(within(dialog).getByText('9 of 10')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(blobOf(dialog.querySelector('img')!)).toBe('sha8');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Image' })).toBeNull());
  });

  it('adds thumbnails as results arrive while the step runs', () => {
    const running = read(2, { result: undefined, running: true });
    const { rerender } = render(<ToolActivity steps={[read(1), running]} />);
    expect(screen.getAllByRole('button', { name: /Read image/ })).toHaveLength(1);
    rerender(<ToolActivity steps={[read(1), read(2)]} />);
    expect(screen.getAllByRole('button', { name: /Read image/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Read image 1 of 2', 'Read image 2 of 2']);
  });
});

describe('ZoomableImage', () => {
  it('shows a zoom-in cursor and opens its group in the lightbox', async () => {
    const group = [
      { src: 'https://x.test/a.png', alt: 'A' },
      { src: 'https://x.test/b.png', alt: 'B' },
    ];
    render(<ZoomableImage group={group} index={1} className="max-h-40" />);
    const button = screen.getByRole('button', { name: 'B' });
    expect(button.className).toContain('cursor-zoom-in');
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Image' });
    expect(within(dialog).getByText('2 of 2')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous image' }));
    expect(within(dialog).getByRole('img', { name: 'A' })).toBeTruthy();
  });
});
