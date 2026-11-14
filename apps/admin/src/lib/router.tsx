/** A small history router: /, /downloads, /issues, /features, /r/<id>, with the inbox's filters in the query. */
import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export type Route =
  | { page: 'overview' }
  | { page: 'downloads' }
  | { page: 'inbox'; kind: 'issue' | 'feature' }
  | { page: 'report'; id: string }
  | { page: 'missing' };

export function parse(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { page: 'overview' };
  if (path === '/downloads') return { page: 'downloads' };
  if (path === '/issues') return { page: 'inbox', kind: 'issue' };
  if (path === '/features') return { page: 'inbox', kind: 'feature' };
  const m = /^\/r\/([IF]-[0-9A-Z]{6})$/.exec(path);
  if (m) return { page: 'report', id: m[1]! };
  return { page: 'missing' };
}

const EVENT = 'atelier-admin:navigate';

export function navigate(href: string, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', href);
  else history.pushState(null, '', href);
  window.dispatchEvent(new Event(EVENT));
}

/** The current location, re-rendered on navigation. */
export function useLocation(): { pathname: string; search: URLSearchParams } {
  const read = () => ({ pathname: location.pathname, search: new URLSearchParams(location.search) });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const update = () => setLoc(read());
    window.addEventListener('popstate', update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return loc;
}

/** A link that navigates in place; a modified click (new tab) is left to the browser. */
export function Link({ href, onClick, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
    window.scrollTo(0, 0);
  };
  return (
    <a href={href} onClick={click} {...rest}>
      {children}
    </a>
  );
}
