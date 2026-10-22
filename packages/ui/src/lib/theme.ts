import { useMemo, useSyncExternalStore } from 'react';

/** The resolved app theme, as `useAppearance` mirrors it onto `<html data-theme>`. */
export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, read);
}

const read = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

export interface SyntaxThemes {
  light: string;
  dark: string;
}

/**
 * The person's syntax theme ids, as `useAppearance` mirrors them onto `<html data-syntax-light/-dark>`.
 * Signed out (or still loading), the Atelier themes apply.
 */
export function useSyntaxThemes(): SyntaxThemes {
  const pair = useSyncExternalStore(subscribe, readSyntax);
  return useMemo(() => {
    const [light, dark] = pair.split(' ') as [string, string];
    return { light, dark };
  }, [pair]);
}

// A string, so the snapshot is stable between renders.
const readSyntax = (): string => {
  const { syntaxLight = 'atelier-light', syntaxDark = 'atelier-dark' } = document.documentElement.dataset;
  return `${syntaxLight} ${syntaxDark}`;
};

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-syntax-light', 'data-syntax-dark'] });
  return () => observer.disconnect();
}
