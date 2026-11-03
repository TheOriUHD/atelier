import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VideoLightbox } from './video-lightbox.tsx';

const videos = [
  { src: 'https://x.test/a.mp4', alt: 'First', width: 1280, height: 720 },
  { src: 'https://x.test/b.mp4', alt: 'Second' },
  { src: 'https://x.test/c.webm', alt: 'Third' },
];

function Harness({ start = 0, withDetails = false }: { start?: number; withDetails?: boolean }) {
  const [index, setIndex] = useState<number | null>(null);
  const [details, setDetails] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setIndex(start)}>
        Open
      </button>
      <VideoLightbox
        videos={videos}
        index={index}
        onIndexChange={setIndex}
        actions={(i) => <button type="button">Act on {i}</button>}
        {...(withDetails ? { details: (i: number) => <p>Details of {i}</p>, detailsOpen: details, onDetailsOpenChange: setDetails } : {})}
      />
    </>
  );
}

const player = () => screen.getByRole('dialog', { name: 'Video' }).querySelector('video')!;

describe('VideoLightbox', () => {
  it('shows the video in the browser’s own player, muted, looping and inline, in the shape it has', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('dialog', { name: 'Video' });
    const video = player();
    expect(video.getAttribute('src')).toBe('https://x.test/a.mp4');
    expect(video.getAttribute('aria-label')).toBe('First');
    expect(video.controls).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.style.aspectRatio).toBe('1280 / 720');
  });

  it('steps with buttons and keys, but leaves the arrow keys to the player while it has focus', async () => {
    render(<Harness start={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Video' });
    fireEvent.click(screen.getByRole('button', { name: 'Next video' }));
    expect(player().getAttribute('aria-label')).toBe('Third');
    expect(screen.getByRole('button', { name: 'Next video' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(player(), { key: 'ArrowLeft' });
    expect(player().getAttribute('aria-label')).toBe('Third');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(player().getAttribute('aria-label')).toBe('Second');
    fireEvent.click(screen.getByRole('button', { name: 'Previous video' }));
    expect(player().getAttribute('aria-label')).toBe('First');
  });

  it('has no arrows for a single video', async () => {
    render(
      <VideoLightbox videos={[videos[0]!]} index={0} onIndexChange={() => {}} />,
    );
    await screen.findByRole('dialog', { name: 'Video' });
    expect(screen.queryByRole('button', { name: 'Next video' })).toBeNull();
  });

  it('closes on Escape, the close button and a click beside the video', async () => {
    render(<Harness />);
    const open = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      return screen.findByRole('dialog', { name: 'Video' });
    };
    const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const dialog = await open();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await closed();
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await closed();
    await open();
    fireEvent.click(player().parentElement!);
    await closed();
  });

  it('does not close when the video itself is clicked, which plays and pauses it', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('dialog', { name: 'Video' });
    fireEvent.click(player());
    expect(screen.queryByRole('dialog', { name: 'Video' })).not.toBeNull();
  });

  it('offers the caller’s actions and a details panel that opens and closes', async () => {
    render(<Harness withDetails />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('dialog', { name: 'Video' });
    expect(screen.getByRole('button', { name: 'Act on 0' })).toBeTruthy();
    expect(screen.queryByText('Details of 0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Details of 0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.queryByText('Details of 0')).toBeNull();
  });
});
