import { useState } from 'react';
import { Check, ClipboardCopy } from 'lucide-react';
import { Button, type ButtonProps } from '../components/ui/index.ts';
import { copyDiagnostics } from '../lib/copy-diagnostics.ts';

/**
 * Puts the diagnostics on the clipboard (Settings › System, and the error screen). It says what happened on the button
 * itself instead of a toast, because the error screen has no toaster of its own to rely on.
 */
export function CopyDiagnosticsButton({ variant, size }: Pick<ButtonProps, 'variant' | 'size'>) {
  const [state, setState] = useState<'idle' | 'working' | 'copied' | 'failed'>('idle');
  const press = async () => {
    setState('working');
    const text = await copyDiagnostics().catch(() => null);
    setState(text ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 2500);
  };
  return (
    <Button variant={variant} size={size} loading={state === 'working'} leadingIcon={state === 'copied' ? Check : ClipboardCopy} onClick={() => void press()} aria-live="polite">
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy diagnostics'}
    </Button>
  );
}
