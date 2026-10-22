/** Mirrors the appearance preferences onto <html> attributes consumed by the generated theme CSS. */
import { useEffect, useState } from 'react';
import type { UserPrefs } from '@atelier/protocol';
import { desktop } from './platform.ts';

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Without preferences (signed out, or still loading) the system theme and the bundled fonts apply. */
export function useAppearance(prefs: Pick<UserPrefs, 'appearance' | 'code'> | undefined): 'light' | 'dark' {
  const [prefersDark, setPrefersDark] = useState(systemDark);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setPrefersDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const appearance = prefs?.appearance;
  const code = prefs?.code;
  const resolved: 'light' | 'dark' = appearance?.theme === 'light' ? 'light' : appearance?.theme === 'dark' ? 'dark' : prefersDark ? 'dark' : 'light';

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    if (!appearance) return;
    root.dataset.chatFont = appearance.chatFont;
    root.dataset.uiFont = appearance.interfaceFont;
    root.dataset.textSize = appearance.textSize;
    root.dataset.transcriptWidth = appearance.transcriptWidth;
    root.dataset.motion = appearance.motion;
  }, [appearance, resolved]);

  useEffect(() => {
    if (!code) return;
    const root = document.documentElement;
    // Read by the code highlighter (lib/theme.ts › useSyntaxThemes).
    root.dataset.syntaxLight = code.syntaxTheme.light;
    root.dataset.syntaxDark = code.syntaxTheme.dark;
    // The schema keeps quotes out of the name; the bundled font stays the fallback.
    const font = code.font.trim();
    if (font) root.style.setProperty('--at-font-code', `"${font}", var(--at-font-mono)`);
    else root.style.removeProperty('--at-font-code');
  }, [code]);

  useEffect(() => desktop?.setTheme(resolved), [resolved]);
  return resolved;
}
