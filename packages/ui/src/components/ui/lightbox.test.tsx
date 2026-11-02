import { useState, type ComponentProps } from 'react';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Lightbox } from './lightbox.tsx';

const images = [
  { src: 'https://x.test/a.png', alt: 'First' },
  { src: 'https://x.test/b.png', alt: 'Second' },
  { src: 'https://x.test/c.png', alt: 'Third' },
];

function Harness({ start = 0 }: { start?: number }) {
  const [index, setIndex] = useState<number | null>(null);
  return (
    <>
      <button type="button" onClick={() => setIndex(start)}>
        Open
      </button>
      <Lightbox images={images} index={index} onIndexChange={setIndex} />
    </>
  );
}

const shown = () => screen.getByRole('dialog', { name: 'Image' }).querySelector('img')!.getAttribute('alt');

describe('Lightbox', () => {
  it('shows the image fitted to the window, steps with buttons and arrow keys, and says where it is', async () => {
    render(<Harness start={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Image' });
    const img = dialog.querySelector('img')!;
    expect(img.className.split(' ')).toEqual(expect.arrayContaining(['max-h-[90vh]', 'max-w-[min(90vw,100%)]', 'object-contain', 'rounded-xl']));
    expect(shown()).toBe('Second');
    expect(screen.getByText('2 of 3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(shown()).toBe('Third');
    expect(screen.getByRole('button', { name: 'Next image' }).hasAttribute('disabled')).toBe(true);

    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(shown()).toBe('First');
    expect(screen.getByText('1 of 3')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(shown()).toBe('First');

    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    expect(shown()).toBe('First');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(shown()).toBe('Second');
  });

  it('closes on Escape, on the close button and on a click beside the image', async () => {
    render(<Harness />);
    const open = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      return screen.findByRole('dialog', { name: 'Image' });
    };
    const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.keyDown(await open(), { key: 'Escape' });
    await closed();

    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await closed();

    const dialog = await open();
    fireEvent.click(dialog.querySelector('img')!);
    expect(screen.getByRole('dialog', { name: 'Image' })).toBeTruthy();
    fireEvent.click(dialog);
    await closed();
  });

  it('has no arrows or count for a single image', async () => {
    function One() {
      const [index, setIndex] = useState<number | null>(0);
      return <Lightbox images={[images[0]!]} index={index} onIndexChange={setIndex} />;
    }
    render(<One />);
    await screen.findByRole('dialog', { name: 'Image' });
    expect(screen.queryByRole('button', { name: 'Next image' })).toBeNull();
    expect(screen.queryByText('1 of 1')).toBeNull();
  });

  it('keeps the image shown while it closes, not the first of the group', async () => {
    const { rerender } = render(<Lightbox images={images} index={2} onIndexChange={() => {}} />);
    await screen.findByRole('dialog', { name: 'Image' });
    rerender(<Lightbox images={images} index={null} onIndexChange={() => {}} />);
    expect(screen.queryByRole('dialog')?.querySelector('img')?.getAttribute('alt') ?? 'Third').toBe('Third');
  });
});

describe('Lightbox zoom', () => {
  /** jsdom lays nothing out: a picture of 800×400 fitted from 1600×800 on a stage of 1000×600. */
  async function open(props: Partial<ComponentProps<typeof Lightbox>> = {}) {
    function One() {
      const [index, setIndex] = useState<number | null>(0);
      return <Lightbox images={images} index={index} onIndexChange={setIndex} {...props} />;
    }
    render(<One />);
    const dialog = await screen.findByRole('dialog', { name: 'Image' });
    const img = dialog.querySelector('img')!;
    const stage = img.parentElement!;
    Object.defineProperties(img, { offsetWidth: { value: 800 }, offsetHeight: { value: 400 }, naturalWidth: { value: 1600 } });
    Object.defineProperties(stage, { clientWidth: { value: 1000 }, clientHeight: { value: 600 } });
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 }) as DOMRect;
    return { dialog, img, stage };
  }
  const scale = (img: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(img.style.transform)?.[1]);
  const moved = (img: HTMLElement) => /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(img.style.transform)!.slice(1, 3).map(Number);

  it('starts fitted', async () => {
    const { img } = await open();
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(screen.getByRole('status').textContent).toBe('Fit');
    expect(screen.getByRole('button', { name: 'Zoom out' }).hasAttribute('disabled')).toBe(true);
  });

  it('zooms with the keys, says how big the image is, and 0 fits it again', async () => {
    const { dialog, img } = await open();
    fireEvent.keyDown(dialog, { key: '+' });
    expect(scale(img)).toBe(1.5);
    // Of the image's real pixels: fitted, 800 of 1600 show.
    expect(screen.getByRole('status').textContent).toBe('75%');
    fireEvent.keyDown(dialog, { key: '=' });
    expect(scale(img)).toBe(2.25);
    fireEvent.keyDown(dialog, { key: '-' });
    expect(scale(img)).toBe(1.5);
    fireEvent.keyDown(dialog, { key: '0' });
    expect(scale(img)).toBe(1);
  });

  it('leaves browser shortcuts alone', async () => {
    const { dialog, img } = await open();
    fireEvent.keyDown(dialog, { key: '+', metaKey: true });
    expect(scale(img)).toBe(1);
  });

  it('zooms with the wheel around the pointer, stopping the page from zooming too', async () => {
    const { img, stage } = await open();
    // The test DOM's WheelEvent has no pointer position of its own.
    const wheel = createEvent.wheel(stage, { deltaY: -350 });
    Object.defineProperties(wheel, { clientX: { value: 700 }, clientY: { value: 300 } });
    // `false`: the event's default was prevented.
    expect(fireEvent(stage, wheel)).toBe(false);
    expect(scale(img)).toBeCloseTo(Math.exp(0.7), 5);
    // The spot under the pointer, 200 px right of center, stays there: the picture moves left.
    expect(moved(img)[0]).toBeLessThan(0);
    expect(moved(img)[1]).toBe(0);
  });

  it('never zooms out past the fitted size', async () => {
    const { img, stage } = await open();
    const wheel = createEvent.wheel(stage, { deltaY: 500 });
    Object.defineProperties(wheel, { clientX: { value: 500 }, clientY: { value: 300 } });
    fireEvent(stage, wheel);
    expect(scale(img)).toBe(1);
  });

  it('goes to actual pixels on a double-click, and back on another', async () => {
    const { img } = await open();
    fireEvent.doubleClick(img, { clientX: 500, clientY: 300 });
    expect(scale(img)).toBe(2);
    expect(screen.getByRole('status').textContent).toBe('100%');
    fireEvent.doubleClick(img, { clientX: 500, clientY: 300 });
    expect(scale(img)).toBe(1);
  });

  it('ignores a double-click beside the image', async () => {
    const { img, stage } = await open();
    fireEvent.doubleClick(stage);
    expect(scale(img)).toBe(1);
  });

  it('has buttons for those without a wheel', async () => {
    const { img } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(scale(img)).toBe(1.5);
    fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }));
    expect(scale(img)).toBe(1);
  });

  it('pans with the arrow keys while zoomed in, and steps through images while fitted', async () => {
    const { dialog, img } = await open();
    fireEvent.keyDown(dialog, { key: '+' });
    fireEvent.keyDown(dialog, { key: '+' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(dialog.querySelector('img')!.getAttribute('alt')).toBe('First');
    expect(moved(img)[0]).toBe(-80);
    fireEvent.keyDown(dialog, { key: '0' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(dialog.querySelector('img')!.getAttribute('alt')).toBe('Second');
  });

  it('starts the next image fitted', async () => {
    const { dialog } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(dialog.querySelector('img')!.style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('drags a zoomed image, up to its edges, and a drag that ends beside it doesn’t close', async () => {
    const { dialog, img, stage } = await open();
    fireEvent.keyDown(dialog, { key: '+' });
    fireEvent.keyDown(dialog, { key: '+' });
    stage.setPointerCapture = () => {};
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100, pointerType: 'mouse', button: 0 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 140, clientY: 100, pointerType: 'mouse' });
    expect(moved(img)[0]).toBe(40);
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 900, clientY: 100, pointerType: 'mouse' });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 900, clientY: 100, pointerType: 'mouse' });
    // Back to the limit: (800 × 2.25 − 1000) / 2.
    expect(moved(img)[0]).toBe(400);
    fireEvent.click(stage);
    expect(screen.getByRole('dialog', { name: 'Image' })).toBeTruthy();
  });

  it('pinches with two fingers, and goes on panning with the one left', async () => {
    const { img, stage } = await open();
    const touch = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', pointerId: number, clientX: number, clientY = 300) => fireEvent[type](stage, { pointerId, clientX, clientY, pointerType: 'touch' });
    touch('pointerDown', 1, 400);
    touch('pointerDown', 2, 600);
    touch('pointerMove', 2, 800);
    expect(scale(img)).toBe(2);
    touch('pointerUp', 2, 800);
    touch('pointerMove', 1, 450);
    expect(scale(img)).toBe(2);
  });

  it('zooms on a double tap', async () => {
    const { img, stage } = await open();
    const tap = () => {
      fireEvent.pointerDown(stage, { pointerId: 1, clientX: 300, clientY: 300, pointerType: 'touch' });
      fireEvent.pointerUp(stage, { pointerId: 1, clientX: 300, clientY: 300, pointerType: 'touch' });
    };
    tap();
    expect(scale(img)).toBe(1);
    tap();
    expect(scale(img)).toBe(2);
  });
});

describe('Lightbox slots', () => {
  it('puts actions beside Close, for the image shown', async () => {
    function Actions() {
      const [index, setIndex] = useState<number | null>(1);
      return <Lightbox images={images} index={index} onIndexChange={setIndex} actions={(at) => <button type="button">Save {images[at]!.alt}</button>} />;
    }
    render(<Actions />);
    await screen.findByRole('dialog', { name: 'Image' });
    expect(screen.getByRole('button', { name: 'Save Second' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByRole('button', { name: 'Save Third' })).toBeTruthy();
  });

  it('has a Details button and panel only when there are details', async () => {
    function Details() {
      const [index, setIndex] = useState<number | null>(0);
      const [open, setOpen] = useState(false);
      return <Lightbox images={images} index={index} onIndexChange={setIndex} details={(at) => <p>About {images[at]!.alt}</p>} detailsOpen={open} onDetailsOpenChange={setOpen} />;
    }
    render(<Details />);
    const dialog = await screen.findByRole('dialog', { name: 'Image' });
    const button = within(dialog).getByRole('button', { name: 'Details' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(within(dialog).queryByRole('complementary')).toBeNull();
    fireEvent.click(button);
    expect(within(dialog).getByRole('complementary', { name: 'Details' }).textContent).toBe('About First');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(within(dialog).getByRole('complementary', { name: 'Details' }).textContent).toBe('About Second');
    fireEvent.click(button);
    expect(within(dialog).queryByRole('complementary')).toBeNull();
  });

  it('shows neither without them', async () => {
    render(<Lightbox images={images} index={0} onIndexChange={() => {}} />);
    await screen.findByRole('dialog', { name: 'Image' });
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  });
});
