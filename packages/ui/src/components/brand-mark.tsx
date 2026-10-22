import { cn } from './ui/index.ts';

/** Atelier's mark: a painter's palette in the brand clay. Original artwork; swap it here to rebrand. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('shrink-0 text-brand-mark', className)}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M12 2.5a9.5 9.5 0 1 0 0 19c1.2 0 1.9-.85 1.9-1.8 0-.5-.2-.95-.55-1.3-.33-.33-.55-.78-.55-1.3 0-1 .8-1.8 1.8-1.8h1.9a5 5 0 0 0 5-5c0-4.3-4.1-7.8-9.5-7.8ZM7.5 12.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Zm3.3-4.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Zm4.6.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z"
      />
    </svg>
  );
}
