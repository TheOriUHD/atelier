// The glow and the steps panel in a tab while Atelier works in it, run in the page with chrome.scripting.executeScript
// (the extension's own isolated world). Like page.ts, each function is sent to the page as its source text: no imports,
// no closures over this module, only its arguments.
//
// Everything sits in a closed shadow root on one element under <html> (not in <body>, so the page's text as read leaves it
// out), and nothing in it takes the pointer: clicks, Atelier's own included, go through to the page. The panel is never
// built from HTML text, only with textContent, so a step can't put markup in the page.

/** What the panel shows. */
export interface OverlayView {
  /** The chat's name. */
  title: string;
  /** The latest steps, oldest first: while `state` is working, the last is the one under way. */
  steps: string[];
  /** How many steps came before the ones shown. */
  earlier: number;
  state: 'working' | 'done' | 'waiting';
}

/** Shows the glow and the panel, or brings them up to date. `done` fades both out and removes them after a moment. */
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
    .panel {
      position: fixed; left: 14px; bottom: 14px; box-sizing: border-box; pointer-events: none;
      width: max-content; min-width: 220px; max-width: min(360px, calc(100vw - 28px));
      padding: 10px 12px 11px; border-radius: 12px;
      background: rgba(252, 252, 251, 0.95); color: #1c1c1b; border: 1px solid rgba(198, 97, 63, 0.3);
      box-shadow: 0 12px 32px -10px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.08);
      -webkit-backdrop-filter: blur(14px) saturate(1.2); backdrop-filter: blur(14px) saturate(1.2);
      font: 500 12.5px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      letter-spacing: normal; text-align: left; direction: ltr; -webkit-font-smoothing: antialiased;
      animation: rise 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
      transition: opacity 0.4s ease, transform 0.4s ease;
    }
    .panel.gone { opacity: 0; transform: translateY(6px); }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .mark { flex: none; width: 18px; height: 18px; border-radius: 5px; background: #c6613f; display: grid; place-items: center; }
    .mark svg { width: 13px; height: 13px; fill: #fbf8f2; }
    .title { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
    .state { flex: none; display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: #b5532f; }
    .state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse 1.2s ease-in-out infinite; }
    .panel[data-state="done"] .state, .panel[data-state="waiting"] .state { color: rgba(28, 28, 27, 0.6); }
    .panel[data-state="done"] .state::before, .panel[data-state="waiting"] .state::before { animation: none; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    .steps { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
    .steps li { display: flex; gap: 7px; align-items: flex-start; min-width: 0; color: rgba(28, 28, 27, 0.56); font-weight: 450; }
    .steps li.now { color: #1c1c1b; font-weight: 500; }
    .steps li.enter { animation: rise 0.18s ease-out; }
    .steps .text { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
    .steps .earlier { font-size: 11px; color: rgba(28, 28, 27, 0.45); padding-left: 19px; }
    .icon { flex: none; width: 12px; height: 12px; margin-top: 2.5px; box-sizing: border-box; }
    .check { fill: none; stroke: #c6613f; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; opacity: 0.8; }
    .spin { border-radius: 50%; border: 1.7px solid rgba(198, 97, 63, 0.25); border-top-color: #c6613f; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: dark) {
      .panel { background: rgba(30, 30, 29, 0.94); color: #f2efe9; border-color: rgba(222, 132, 99, 0.34); box-shadow: 0 12px 32px -10px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.3); }
      .state { color: #e48f6e; }
      .panel[data-state="done"] .state, .panel[data-state="waiting"] .state { color: rgba(242, 239, 233, 0.6); }
      .steps li { color: rgba(242, 239, 233, 0.56); }
      .steps li.now { color: #f2efe9; }
      .steps .earlier { color: rgba(242, 239, 233, 0.42); }
      .check { stroke: #de8463; }
    }
    @media (prefers-reduced-motion: reduce) {
      .glow, .panel, .steps li.enter, .state::before, .spin { animation: none; }
      .spin { border-color: #c6613f; }
    }
  `;
  type Parts = { shadow: ShadowRoot; glow: HTMLElement; panel: HTMLElement; title: HTMLElement; state: HTMLElement; steps: HTMLElement; shown: number; timer?: number; stale?: number };
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
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'status');
    const head = document.createElement('div');
    head.className = 'head';
    const mark = document.createElement('span');
    mark.className = 'mark';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', GLYPH);
    svg.append(path);
    mark.append(svg);
    const title = document.createElement('span');
    title.className = 'title';
    const state = document.createElement('span');
    state.className = 'state';
    head.append(mark, title, state);
    const steps = document.createElement('ol');
    steps.className = 'steps';
    panel.append(head, steps);
    shadow.append(style, glow, panel);
    host.__atelierOverlay = { shadow, glow, panel, title, state, steps, shown: 0 };
    root.append(host);
  } else if (host.parentNode !== root) root.append(host);

  const parts = host.__atelierOverlay!;
  clearTimeout(parts.timer);
  clearTimeout(parts.stale);
  parts.panel.classList.remove('gone');
  parts.panel.dataset.state = view.state;
  parts.glow.classList.toggle('off', view.state !== 'working');
  parts.title.textContent = view.title.trim() || 'Atelier';
  parts.state.textContent = view.state === 'working' ? 'Working' : view.state === 'waiting' ? 'Waiting for you' : 'Done';

  const total = view.earlier + view.steps.length;
  const list: HTMLElement[] = [];
  if (view.earlier > 0) {
    const more = document.createElement('li');
    more.className = 'earlier';
    more.textContent = view.earlier === 1 ? '1 earlier step' : `${view.earlier} earlier steps`;
    list.push(more);
  }
  view.steps.forEach((text, i) => {
    const now = view.state === 'working' && i === view.steps.length - 1;
    const item = document.createElement('li');
    if (now) item.className = 'now';
    // Only a step that wasn't there before comes in with a movement.
    if (view.earlier + i >= parts.shown) item.classList.add('enter');
    let icon: Element;
    if (now) {
      icon = document.createElement('span');
      icon.setAttribute('class', 'icon spin');
    } else {
      icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'icon check');
      icon.setAttribute('viewBox', '0 0 12 12');
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tick.setAttribute('d', 'M2.5 6.4 4.9 8.7 9.5 3.6');
      icon.append(tick);
    }
    const label = document.createElement('span');
    label.className = 'text';
    label.textContent = text;
    item.append(icon, label);
    list.push(item);
  });
  parts.steps.replaceChildren(...list);
  parts.shown = total;

  const fadeAndGo = (after: number) => {
    parts.timer = window.setTimeout(() => {
      parts.glow.classList.add('off');
      parts.panel.classList.add('gone');
      parts.timer = window.setTimeout(() => host!.remove(), 450);
    }, after);
  };
  if (view.state === 'done') fadeAndGo(4_000);
  else parts.stale = window.setTimeout(() => fadeAndGo(0), STALE_MS);
}

/** Takes the glow and the panel away at once (the chat moved on to another tab). */
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
