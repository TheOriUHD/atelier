import { useState, type ReactNode } from 'react';
import { Button, TextField } from '../../components/ui/index.ts';

export interface SecretFieldProps {
  /** The newly typed secret. Never prefilled: stored secrets stay in the backend. */
  value: string;
  onValueChange(value: string): void;
  /** Masked hint for the stored secret ("••••3f9a"); shown instead of the input until Replace. */
  stored?: string | undefined;
  /** The secret is imported from this environment variable instead of typed. */
  envVar?: string | undefined;
  /** Switches from the environment variable to a typed key (only with `envVar`). */
  onDropEnv?(): void;
  /** Id of the element that labels the input. */
  labelledBy?: string;
  placeholder?: string;
  invalid?: boolean;
}

/** Masked secret input that shows a stored secret only as its masked tail. */
export function SecretField({ value, onValueChange, stored, envVar, onDropEnv, labelledBy, placeholder, invalid }: SecretFieldProps) {
  const [replacing, setReplacing] = useState(false);

  if (envVar) {
    return (
      <SecretBox action={<Button size="xs" variant="ghost" onClick={onDropEnv}>Enter a key</Button>}>
        From <span className="font-mono text-code">${envVar}</span>
      </SecretBox>
    );
  }
  if (stored && !replacing) {
    return (
      <SecretBox action={<Button size="xs" variant="ghost" onClick={() => setReplacing(true)}>Replace</Button>}>
        <span className="font-mono text-code text-fg-secondary">{stored}</span>
      </SecretBox>
    );
  }
  return (
    <TextField
      type="password"
      aria-labelledby={labelledBy}
      autoComplete="off"
      spellCheck={false}
      autoFocus={replacing}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      placeholder={stored ? 'New key' : placeholder}
      invalid={invalid}
    />
  );
}

function SecretBox({ action, children }: { action: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between gap-2 rounded-lg bg-fill-field pr-1 pl-3 text-body text-fg inset-ring inset-ring-fill-field-ring">
      <span className="min-w-0 truncate">{children}</span>
      {action}
    </div>
  );
}
