/** System, light or dark: kept in this browser only (public/theme.js applies it before the first paint). */
import { useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'atelier-admin-theme';

function stored(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(stored);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // Not kept; it still applies now.
    }
  }, [theme]);
  return [theme, setTheme];
}
