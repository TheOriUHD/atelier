import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(img.className.split(' ')).toEqual(expect.arrayContaining(['max-h-[90vh]', 'max-w-[90vw]', 'object-contain', 'rounded-xl']));
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
});
