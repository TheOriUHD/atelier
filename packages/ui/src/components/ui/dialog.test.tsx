import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button.tsx';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from './dialog.tsx';
import { TextField } from './text-field.tsx';

function CreateProject() {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="primary" />}>New project</DialogTrigger>
      <DialogContent title="Create a project" description="Projects keep chats and files together.">
        <TextField aria-label="Name" placeholder="Name your project" />
        <DialogFooter>
          <DialogClose render={<Button />}>Cancel</DialogClose>
          <Button variant="primary">Create project</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('opens from its trigger with title, description and popup styling', async () => {
    render(<CreateProject />);
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    const dialog = await screen.findByRole('dialog', { name: 'Create a project' });
    expect(dialog.style.width).toBe('520px');
    expect(dialog.className.split(' ')).toEqual(
      expect.arrayContaining(['p-6', 'rounded-2xl', 'bg-popover', 'shadow-lg', 'data-starting-style:scale-96']),
    );
    expect(dialog.className).toContain('duration-(--at-duration-base)');
    expect(screen.getByText('Create a project').className).toContain('text-title');
    expect(screen.getByText('Projects keep chats and files together.').className).toContain('text-fg-secondary');
    const close = screen.getByRole('button', { name: 'Close' }).className.split(' ');
    expect(close).toEqual(expect.arrayContaining(['size-8', 'absolute', 'top-[22px]', 'right-4']));
    // Button must not set its own position, or it would override the caller's `absolute`.
    expect(close).not.toContain('relative');
  });

  it('dims what lies under a nested dialog and closes it, alone, when that is clicked', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent title="Settings">
          <Dialog>
            <DialogTrigger render={<Button />}>Add provider</DialogTrigger>
            <DialogContent title="Choose where your models run">
              <p>Ollama</p>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
    const inner = await screen.findByRole('dialog', { name: 'Choose where your models run' });
    const backdrops = document.querySelectorAll('div[class*="bg-backdrop"]');
    // One per dialog: the nested one is there, and lighter than the first.
    expect(backdrops.length).toBe(2);
    expect(backdrops[1]!.className).toContain('has-[+[data-nested]]:opacity-60');
    expect(inner.hasAttribute('data-nested')).toBe(true);

    fireEvent.pointerDown(backdrops[1]!);
    fireEvent.mouseDown(backdrops[1]!);
    fireEvent.click(backdrops[1]!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose where your models run' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('closes with Escape', async () => {
    render(<CreateProject />);
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes from the close button and from a DialogClose', async () => {
    render(<CreateProject />);
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('honours a custom width', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent title="Wide" width={720}>
          Body
        </DialogContent>
      </Dialog>,
    );
    expect((await screen.findByRole('dialog')).style.width).toBe('720px');
  });
});

function DeleteChat({ onConfirm }: { onConfirm: () => void | Promise<void> }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete session?"
        description="This session will be permanently deleted."
        onConfirm={onConfirm}
      />
    </>
  );
}

describe('ConfirmDialog', () => {
  it('renders an alert dialog with focus on the danger action', async () => {
    render(<DeleteChat onConfirm={() => {}} />);
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete session?' });
    expect(dialog.style.width).toBe('400px');
    expect(dialog.className).toContain('p-5');
    expect(screen.getByText('Delete session?').className).toContain('text-section-heading');
    expect(screen.getByText('This session will be permanently deleted.').className).toContain('text-fg-secondary');

    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm.className).toContain('bg-danger');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('bg-fill-secondary');
    await waitFor(() => expect(document.activeElement).toBe(confirm));
  });

  it('cancels without confirming', async () => {
    const onConfirm = vi.fn();
    render(<DeleteChat onConfirm={onConfirm} />);
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows loading while an async confirm runs, then closes', async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((done) => (resolve = done)));
    render(<DeleteChat onConfirm={onConfirm} />);
    await screen.findByRole('alertdialog');

    const confirm = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(confirm.getAttribute('aria-busy')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    // A second press while pending is ignored, and Escape does not dismiss.
    fireEvent.click(confirm);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('state').textContent).toBe('open');

    await act(async () => resolve());

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
  });

  it('closes right away for a synchronous confirm', async () => {
    const onConfirm = vi.fn();
    render(<DeleteChat onConfirm={onConfirm} />);
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
