import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { IconButton, type ButtonSize } from '../../components/ui/index.ts';

/** Copies `text`; the icon turns into a check for 1.5s. */
export function CopyButton({
  text,
  size = 'xs',
  label = 'Copy',
  className,
}: {
  text: string;
  size?: ButtonSize;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={copied ? 'Copied' : label}
      size={size}
      disabled={!text}
      className={className}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    />
  );
}
