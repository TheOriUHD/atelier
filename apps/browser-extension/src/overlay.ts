// The glow and the step pill in a tab while Atelier works in it, run in the page with chrome.scripting.executeScript (the
// extension's own isolated world). Like page.ts, each function is sent to the page as its source text: no imports, no
// closures over this module, only its arguments.
//
// The pill shows one line: what Atelier is doing this moment ("Reading page…", "Clicking “Sign in”…"), "Thinking…"
// between steps, then "Done". Everything sits in a closed shadow root on one element under <html> (not in <body>, so the
// page's text as read leaves it out), and nothing in it takes the pointer: clicks, Atelier's own included, go through to
// the page. The text is only ever set with textContent, so a step can't put markup in the page.

/** What the pill shows. */
export interface OverlayView {
  /** The step under way (while working); the other states have their own words. */
  step: string;
  /** working: a step is under way; thinking: between steps; waiting: on the person; done: the turn ended. */
  state: 'working' | 'thinking' | 'waiting' | 'done';
}

/** Shows the glow and the pill, or brings them up to date. `done` fades both out and removes them after a moment. */
export function showOverlay(view: OverlayView): void {
  const TAG = 'atelier-overlay';
  /** A working overlay with no news for this long goes by itself (a turn that ended without telling the extension). */
  const STALE_MS = 10 * 60_000;
  const GLYPH =
    'M12 2.5a9.5 9.5 0 1 0 0 19c1.2 0 1.9-.85 1.9-1.8 0-.5-.2-.95-.55-1.3-.33-.33-.55-.78-.55-1.3 0-1 .8-1.8 1.8-1.8h1.9a5 5 0 0 0 5-5c0-4.3-4.1-7.8-9.5-7.8ZM7.5 12.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Zm3.3-4.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Zm4.6.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z';
  const CSS = `
    :host { all: initial; }
    .glow {
      position: fixed; inset: 0; pointer-events: none;
      box-shadow: inset 0 0 0 2px rgba(217, 119, 87, 0.9), inset 0 0 24px 4px rgba(217, 119, 87, 0.42), inset 0 0 110px 24px rgba(217, 119, 87, 0.14);
      animation: breathe 2.6s ease-in-out infinite alternate;
      transition: opacity 0.5s ease;
    }
    .glow.off { opacity: 0; animation: none; }
    @keyframes breathe { from { opacity: 0.62; } to { opacity: 1; } }
    .pill {
      position: fixed; left: 14px; bottom: 14px; box-sizing: border-box; pointer-events: none;
      display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px 0 8px;
      max-width: min(440px, calc(100vw - 28px)); border-radius: 999px;
      background: rgba(252, 252, 251, 0.94); color: #1c1c1b; border: 1px solid rgba(198, 97, 63, 0.3);
      box-shadow: 0 10px 28px -10px rgba(0, 0, 0, 0.3), 0 2px 6px rgba(0, 0, 0, 0.08);
      -webkit-backdrop-filter: blur(14px) saturate(1.2); backdrop-filter: blur(14px) saturate(1.2);
      font: 500 13px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      letter-spacing: normal; text-align: left; direction: ltr; white-space: nowrap; -webkit-font-smoothing: antialiased;
      animation: rise 0.24s cubic-bezier(0.2, 0.8, 0.2, 1);
      transition: opacity 0.4s ease, transform 0.4s ease;
    }
    .pill.gone { opacity: 0; transform: translateY(6px); }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .mark { flex: none; width: 20px; height: 20px; border-radius: 6px; background: #c6613f; display: grid; place-items: center; }
    .mark svg { width: 14px; height: 14px; fill: #fbf8f2; }
    .pill[data-state="working"] .mark, .pill[data-state="thinking"] .mark { animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 50% { transform: scale(0.86); opacity: 0.8; } }
    .line { flex: 1 1 auto; min-width: 0; overflow: hidden; }
    .text { display: block; overflow: hidden; text-overflow: ellipsis; padding: 1px 0; }
    .text.enter { animation: swap 0.2s cubic-bezier(0.2, 0.8, 0.2, 1); }
    @keyframes swap { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
    /* A light that runs over the words while something is under way. */
    .pill[data-state="working"] .text, .pill[data-state="thinking"] .text {
      color: transparent; -webkit-background-clip: text; background-clip: text;
      background-image: linear-gradient(90deg, #1c1c1b 0%, #1c1c1b 38%, #d97757 50%, #1c1c1b 62%, #1c1c1b 100%);
      background-size: 250% 100%; animation: shimmer 2.4s linear infinite;
    }
    .pill[data-state="working"] .text.enter, .pill[data-state="thinking"] .text.enter { animation: swap 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), shimmer 2.4s linear infinite; }
    .pill[data-state="thinking"] .text { opacity: 0.75; }
    @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -150% 0; } }
    .pill[data-state="waiting"] .text, .pill[data-state="done"] .text { color: rgba(28, 28, 27, 0.72); }
    @media (prefers-color-scheme: dark) {
      .pill { background: rgba(30, 30, 29, 0.93); color: #f2efe9; border-color: rgba(222, 132, 99, 0.34); box-shadow: 0 10px 28px -10px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.3); }
      .pill[data-state="working"] .text, .pill[data-state="thinking"] .text {
        background-image: linear-gradient(90deg, #f2efe9 0%, #f2efe9 38%, #e48f6e 50%, #f2efe9 62%, #f2efe9 100%);
      }
      .pill[data-state="waiting"] .text, .pill[data-state="done"] .text { color: rgba(242, 239, 233, 0.72); }
    }
    @media (prefers-reduced-motion: reduce) {
      .glow, .pill, .mark, .text, .text.enter { animation: none !important; }
      .pill[data-state="working"] .text, .pill[data-state="thinking"] .text { color: inherit; background: none; }
    }
  `;
  type Parts = { glow: HTMLElement; pill: HTMLElement; line: HTMLElement; shown: string; timer?: number; stale?: number };
  type Host = HTMLElement & { __atelierOverlay?: Parts };

  const root = document.documentElement;
  if (!root) return;
  let host = document.querySelector(TAG) as Host | null;
  if (!host || !host.__atelierOverlay) {
    host?.remove();
    host = document.createElement(TAG) as Host;
    host.style.cssText = 'all: initial !important; display: block !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const glow = document.createElement('div');
    glow.className = 'glow';
    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    const mark = document.createElement('span');
    mark.className = 'mark';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', GLYPH);
    svg.append(path);
    mark.append(svg);
    const line = document.createElement('span');
    line.className = 'line';
    pill.append(mark, line);
    shadow.append(style, glow, pill);
    host.__atelierOverlay = { glow, pill, line, shown: '' };
    root.append(host);
  } else if (host.parentNode !== root) root.append(host);

  const parts = host.__atelierOverlay!;
  clearTimeout(parts.timer);
  clearTimeout(parts.stale);
  parts.pill.classList.remove('gone');
  parts.pill.dataset.state = view.state;
  parts.glow.classList.toggle('off', view.state === 'waiting' || view.state === 'done');

  const words = view.state === 'thinking' ? 'Thinking…' : view.state === 'waiting' ? 'Waiting for you' : view.state === 'done' ? 'Done' : view.step.trim() || 'Working…';
  // Only new words come in with a movement; the same step painted again (a new page in the tab) stays still.
  if (words !== parts.shown) {
    const text = document.createElement('span');
    text.className = parts.shown ? 'text enter' : 'text';
    text.textContent = words;
    parts.line.replaceChildren(text);
    parts.shown = words;
  }

  const fadeAndGo = (after: number) => {
    parts.timer = window.setTimeout(() => {
      parts.glow.classList.add('off');
      parts.pill.classList.add('gone');
      parts.timer = window.setTimeout(() => host!.remove(), 450);
    }, after);
  };
  if (view.state === 'done') fadeAndGo(2_500);
  else parts.stale = window.setTimeout(() => fadeAndGo(0), STALE_MS);
}

/** Takes the glow and the pill away at once (the chat moved on to another tab). */
export function removeOverlay(): void {
  document.querySelector('atelier-overlay')?.remove();
}

/** Hides the overlay for a screenshot, so the model sees the page as it is; `false` shows it again. */
export function hideOverlay(hidden: boolean): void {
  const host = document.querySelector('atelier-overlay') as HTMLElement | null;
  if (!host) return;
  if (hidden) host.style.setProperty('visibility', 'hidden', 'important');
  else host.style.removeProperty('visibility');
}
