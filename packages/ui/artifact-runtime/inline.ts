/** Standalone, opaque-origin inline visual page. Never shares the application's DOM or storage. */
import defaults from './inline.css?inline';
import interFont from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?inline';

// Embed the app's own face: the opaque frame cannot inherit it or fetch assets after its CSP tightens.
const stylesheet = `@font-face{font-family:"Inter Variable";font-style:normal;font-weight:100 900;font-display:swap;src:url("${interFont}") format("woff2")}\n${defaults}`;

type RenderMessage = {
  type: 'inline:render'; html: string; final: boolean;
  theme: 'light' | 'dark'; reducedMotion: boolean;
};

const post = (message: Record<string, unknown>) => window.parent.postMessage(message, '*');
const root = document.getElementById('inline-root')!;
const baseStyle = document.createElement('style');
baseStyle.textContent = stylesheet;
document.head.append(baseStyle);

// Tighten the server's artifact CSP AFTER loading our only bundle. Generated widgets get no
// external scripts (including same-origin URLs), imports, connections, frames, or remote CSS.
const widgetCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; media-src data: blob:; base-uri 'none'; form-action 'none'";
const policy = document.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
policy.content = widgetCsp;
document.head.append(policy);

let lastHtml: string | null = null;
let finalized = false;
let revision = 0;
let visible = true;
let heightFrame = 0;
let lastHeight = -1;
const widgetStyles: HTMLStyleElement[] = [];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

// document.write/open would replace the shell and its message listener. DOM-based widgets work
// normally; document-replacing legacy widgets get an actionable error instead of a dead frame.
for (const method of ['open', 'write', 'writeln', 'close'] as const) {
  Object.defineProperty(document, method, { configurable: false, value: () => {
    throw new Error(`Inline visuals cannot call document.${method}(); use DOM methods instead.`);
  } });
}

function measure(): void {
  heightFrame = 0;
  // Do not measure documentElement.scrollHeight: its minimum is the previous iframe viewport,
  // which would prevent the host from ever shrinking the frame again.
  const bounds = root.getBoundingClientRect();
  const height = Math.max(1, Math.ceil(Math.max(bounds.height, root.scrollHeight, document.body.getBoundingClientRect().height)));
  if (height !== lastHeight) { lastHeight = height; post({ type: 'inline:height', height }); }
}
function queueHeight(): void {
  if (!heightFrame) heightFrame = requestAnimationFrame(measure);
}
new ResizeObserver(queueHeight).observe(root);
new MutationObserver(queueHeight).observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
// Keep normal widget hash links, but never navigate this frame away from its live bridge.
document.addEventListener('click', (event) => {
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
  if (anchor instanceof HTMLAnchorElement && !anchor.getAttribute('href')?.startsWith('#')) event.preventDefault();
}, true);
document.addEventListener('submit', (event) => event.preventDefault(), true);
window.addEventListener('resize', queueHeight);
document.addEventListener('load', queueHeight, true);
document.fonts?.addEventListener('loadingdone', queueHeight);

/** Parser-created scripts are inert. Preview also drops every other execution entry point. */
function parse(html: string, final: boolean): Document {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  function clean(container: ParentNode): void {
    for (const element of Array.from(container.querySelectorAll('*'))) {
      const tag = element.localName.toLowerCase();
      if (['iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'link', 'meta'].includes(tag)
        || (tag === 'script' && (!final || element.hasAttribute('src') || element.namespaceURI !== 'http://www.w3.org/1999/xhtml'))
        || (!final && ['animate', 'set', 'animatetransform', 'animatemotion'].includes(tag))) {
        element.remove(); continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.replace(/[\p{C}\s]/gu, '').toLowerCase();
        if ((!final && name.startsWith('on')) || name === 'srcdoc'
          || (['href', 'xlink:href', 'src', 'action', 'formaction'].includes(name)
            && (value.startsWith('javascript:') || value.startsWith('vbscript:') || value.startsWith('data:text/html')))) {
          element.removeAttribute(attribute.name);
        }
      }
      if (element instanceof HTMLTemplateElement) clean(element.content);
    }
  }
  clean(parsed);
  return parsed;
}

function preferences(message: RenderMessage): void {
  const documentRoot = document.documentElement;
  const changed = documentRoot.dataset.theme !== message.theme
    || documentRoot.dataset.reducedMotion !== String(message.reducedMotion);
  documentRoot.dataset.theme = message.theme;
  documentRoot.dataset.reducedMotion = String(message.reducedMotion);
  if (changed) document.dispatchEvent(new CustomEvent('inline:theme', {
    detail: { theme: message.theme, reducedMotion: message.reducedMotion },
  }));
  queueHeight();
}

async function render(message: RenderMessage): Promise<void> {
  preferences(message);
  // Theme-only updates and duplicate final deliveries must preserve user state and script identity.
  if (message.html === lastHtml && (finalized || !message.final)) {
    if (finalized) post({ type: 'inline:rendered' });
    return;
  }
  // A finalized widget is immutable for this frame. The host creates a new frame for a new visual.
  if (finalized) return;
  const currentRevision = ++revision;
  const parsed = parse(message.html, message.final);
  lastHtml = message.html;
  finalized = message.final;
  root.inert = !message.final;
  for (const style of widgetStyles.splice(0)) style.remove();
  for (const style of Array.from(parsed.head.querySelectorAll('style'))) {
    const imported = document.importNode(style, true);
    widgetStyles.push(imported);
    document.head.append(imported);
  }
  // Keep body selectors/classes and inline layout from full HTML input without replacing body.
  for (const attribute of Array.from(document.body.attributes)) document.body.removeAttribute(attribute.name);
  for (const attribute of Array.from(parsed.body.attributes)) document.body.setAttribute(attribute.name, attribute.value);
  document.body.style.setProperty('background', 'transparent', 'important');
  root.replaceChildren(...Array.from(parsed.body.childNodes, (node) => document.importNode(node, true)));
  queueHeight();
  if (!message.final) return;

  // Recreate scripts only after the completed DOM is mounted. Classic scripts retain shared global
  // scope and document.getElementById/canvas/menu/dialog work without a second nested document.
  const scripts = [...Array.from(document.head.querySelectorAll('script[data-inline-widget]')), ...Array.from(root.querySelectorAll('script'))];
  // Head scripts belong to the widget too; insert them before body scripts, in source order.
  const headScripts = Array.from(parsed.head.querySelectorAll('script')).map((script) => {
    const placeholder = document.importNode(script, true);
    placeholder.dataset.inlineWidget = '';
    document.head.append(placeholder);
    return placeholder;
  });
  for (const inert of [...headScripts, ...scripts]) {
    if (currentRevision !== revision) return;
    if (inert.hasAttribute('src')) { inert.remove(); continue; }
    const type = (inert.getAttribute('type') ?? '').trim().toLowerCase();
    if (type && !['module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)) continue;
    const active = document.createElement('script');
    if (type === 'module') active.type = 'module';
    active.textContent = inert.textContent;
    const finished = type === 'module' ? new Promise<void>((resolve) => {
      active.addEventListener('load', () => resolve(), { once: true });
      active.addEventListener('error', () => { post({ type: 'inline:error', message: 'Inline module failed to execute; external imports are not supported.' }); resolve(); }, { once: true });
    }) : null;
    inert.replaceWith(active);
    if (finished) await finished;
  }
  // The shell loaded before generated scripts arrived. Support the common initialization idiom.
  document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
  window.dispatchEvent(new Event('load'));
  document.dispatchEvent(new CustomEvent('inline:visibility', { detail: { visible } }));
  queueHeight();
  post({ type: 'inline:rendered' });
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
  const data = event.data;
  if (data.type === 'inline:visibility' && typeof data.visible === 'boolean') {
    visible = data.visible;
    document.documentElement.dataset.inlineVisible = String(visible);
    document.dispatchEvent(new CustomEvent('inline:visibility', { detail: { visible } }));
    if (visible) queueHeight();
  } else if (data.type === 'inline:export' && finalized && lastHtml !== null) {
    const parsed = parse(lastHtml, true);
    // Export receives the same offline policy and Atelier defaults, not the app or bridge.
    post({ type: 'inline:export', html: `<!doctype html><html data-theme="${document.documentElement.dataset.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${widgetCsp}"><style>${stylesheet.replace(/<\/style/gi, '<\\/style')}</style>${parsed.head.innerHTML}</head><body${Array.from(parsed.body.attributes).map((attribute) => ` ${attribute.name}="${attribute.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('')}>${parsed.body.innerHTML}</body></html>` });
  } else if (data.type === 'inline:render' && typeof data.html === 'string'
    && typeof data.final === 'boolean' && (data.theme === 'light' || data.theme === 'dark')
    && typeof data.reducedMotion === 'boolean') {
    void render(data as RenderMessage).catch((error: unknown) => post({ type: 'inline:error', message: errorMessage(error) }));
  }
});
window.addEventListener('error', (event) => post({ type: 'inline:error', message: event.message }));
window.addEventListener('unhandledrejection', (event) => post({ type: 'inline:error', message: errorMessage(event.reason) }));
post({ type: 'inline:ready' });
