// Functions the extension runs inside a page with chrome.scripting.executeScript. Each is sent to the page as its source
// text, so it must be self-contained: no imports, no closures over this module, only its arguments.

import type { BrowserElement } from '@atelier/protocol';

/** What `snapshot` and `find` return (the page part of a `BrowserPage`). */
export interface Snapshot {
  url: string;
  title: string;
  text?: string;
  truncated?: boolean;
  elements?: BrowserElement[];
}

/**
 * The page's text and its usable elements, each tagged with `data-atelier-ref` so a later call finds it again. Elements
 * in the viewport come first, then the rest in reading order. With `query`, only elements whose role, name or value
 * contain it.
 */
export function snapshot(options: { text: boolean; elements: boolean; maxChars: number; maxElements: number; query?: string }): Snapshot {
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', '[contenteditable=""]', '[contenteditable=true]',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=switch]', '[role=tab]', '[role=menuitem]',
    '[role=option]', '[role=combobox]', '[role=textbox]', '[role=searchbox]', '[role=slider]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0]!;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'range') return 'slider';
      return type === 'search' ? 'searchbox' : 'textbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return tag;
  };
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return squash(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      if (squash(text)) return squash(text);
    }
    const id = el.getAttribute('id');
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && squash(label.textContent)) return squash(label.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping !== el && squash(wrapping.textContent)) return squash(wrapping.textContent);
    const own = squash((el as HTMLElement).innerText ?? el.textContent);
    if (own) return own;
    for (const attr of ['placeholder', 'alt', 'title', 'value', 'name']) {
      const v = el.getAttribute(attr);
      if (v && squash(v)) return squash(v);
    }
    const img = el.querySelector('img[alt]');
    return img ? squash(img.getAttribute('alt')) : '';
  };
  const valueOf = (el: Element): string | undefined => {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'checked' : 'unchecked';
      if (el.type === 'password') return el.value ? '••••' : '';
      return el.value;
    }
    if (el instanceof HTMLTextAreaElement) return el.value;
    if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.text ?? '';
    const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? el.getAttribute('aria-pressed');
    return checked ?? undefined;
  };
  const shown = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    return check ? check.call(el, { checkOpacity: true, checkVisibilityCSS: true }) : true;
  };
  const inView = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    return box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
  };

  const out: Snapshot = { url: location.href, title: document.title };
  if (options.text) {
    const text = squash(document.body?.innerText ?? '').replace(/ ?\n ?/g, '\n');
    out.text = clip(text, options.maxChars);
    if (text.length > options.maxChars) out.truncated = true;
  }
  if (options.elements || options.query) {
    const seen = new Set<Element>();
    const all = [...document.querySelectorAll(SELECTOR)].filter((el) => {
      if (seen.has(el) || !shown(el)) return false;
      seen.add(el);
      return true;
    });
    const store = window as unknown as { __atelierNext?: number };
    const query = options.query?.toLowerCase();
    const described = all.map((el): BrowserElement => {
      let ref = Number(el.getAttribute('data-atelier-ref'));
      if (!ref) {
        store.__atelierNext = (store.__atelierNext ?? 0) + 1;
        ref = store.__atelierNext;
        el.setAttribute('data-atelier-ref', String(ref));
      }
      const element: BrowserElement = { ref, role: roleOf(el), name: clip(nameOf(el), 120), visible: inView(el) };
      const value = valueOf(el);
      if (value !== undefined && value !== '') element.value = clip(value, 120);
      if (el instanceof HTMLAnchorElement && el.href) element.href = clip(el.href, 200);
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') element.disabled = true;
      return element;
    });
    const wanted = query
      ? described.filter((e) => `${e.role} ${e.name} ${e.value ?? ''} ${e.href ?? ''}`.toLowerCase().includes(query))
      : described;
    out.elements = [...wanted.filter((e) => e.visible), ...wanted.filter((e) => !e.visible)].slice(0, options.maxElements);
  }
  return out;
}

/**
 * Scrolls the element with this ref into view and returns its centre in the viewport (CSS pixels), where a click lands;
 * null when the page no longer has it.
 */
export function locate(ref: number): { x: number; y: number } | null {
  const el = document.querySelector(`[data-atelier-ref="${ref}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const box = el.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

/** Selects all of the focused field's text (or the element's with this ref), so typing replaces it. */
export function selectAll(ref: number | null): boolean {
  const el = (ref ? document.querySelector(`[data-atelier-ref="${ref}"]`) : document.activeElement) as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    el.select();
    return true;
  }
  if (el.isContentEditable) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }
  return false;
}

/** Chooses an option of the `<select>` with this ref by its text or value; the chosen option's text, or null. */
export function chooseOption(ref: number, option: string): string | null {
  const el = document.querySelector(`[data-atelier-ref="${ref}"]`);
  if (!(el instanceof HTMLSelectElement)) return null;
  const wanted = option.trim().toLowerCase();
  const match =
    [...el.options].find((o) => o.text.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted) ??
    [...el.options].find((o) => o.text.trim().toLowerCase().includes(wanted));
  if (!match) return null;
  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return match.text;
}

/**
 * Runs in the page's own world in Atelier's tabs: a link that would open a tab or a window opens in this one instead, and
 * so does window.open. A new tab would come to the front of the person's window and its app over theirs.
 */
export function keepInThisTab(): void {
  const flag = window as unknown as { __atelierKept?: boolean };
  if (flag.__atelierKept) return;
  flag.__atelierKept = true;
  document.addEventListener(
    'click',
    (event) => {
      const link = (event.target as Element | null)?.closest?.('a[target], area[target]') as HTMLAnchorElement | null;
      if (link && link.target && link.target !== '_self') link.target = '_self';
    },
    true,
  );
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target as HTMLFormElement | null;
      if (form && form.target && form.target !== '_self') form.target = '_self';
    },
    true,
  );
  window.open = ((url?: string | URL) => {
    if (url) location.href = String(url);
    return window;
  }) as typeof window.open;
}
