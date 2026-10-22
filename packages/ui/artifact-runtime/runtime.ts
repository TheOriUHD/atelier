/**
 * Artifact runtime. Loaded in an iframe with `sandbox="allow-scripts"` from a separate origin, so it
 * has no access to the app, its storage or its secrets. It speaks a tiny postMessage protocol:
 *   parent → { type: 'render', artifactType, content, theme }
 *   runtime → { type: 'ready' } | { type: 'rendered' } | { type: 'error', message }
 */

type ArtifactType = 'html' | 'react' | 'svg' | 'mermaid' | 'markdown' | 'code';
type RenderMessage = { type: 'render'; artifactType: ArtifactType; content: string; theme: 'light' | 'dark' };

const post = (message: Record<string, unknown>) => window.parent.postMessage(message, '*');
const root = document.getElementById('root')!;
let unmountReact: (() => void) | null = null;
let tailwindLoaded = false;

const baseStyle = document.createElement('style');
baseStyle.textContent = `
  :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; }
  :root[data-theme='dark'] { color-scheme: dark; }
  body { margin: 0; }
  .md { max-width: 760px; margin: 0 auto; padding: 32px 24px; font: 16px/1.6 Georgia, serif; }
  .md pre { overflow-x: auto; padding: 12px; border-radius: 8px; background: rgba(127,127,127,.12); }
  .md code { font-family: ui-monospace, monospace; font-size: .9em; }
  .md table { border-collapse: collapse; } .md td, .md th { border: 1px solid rgba(127,127,127,.3); padding: 4px 8px; }
  .center { min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
  .center > svg { max-width: 100%; height: auto; }
`;
document.head.append(baseStyle);

async function ensureTailwind(): Promise<void> {
  if (tailwindLoaded) return;
  await import('@tailwindcss/browser');
  tailwindLoaded = true;
}

function resetRoot(): void {
  unmountReact?.();
  unmountReact = null;
  root.replaceChildren();
  root.className = '';
}

async function render(message: RenderMessage): Promise<void> {
  document.documentElement.dataset.theme = message.theme;
  switch (message.artifactType) {
    case 'html':
      // Replace this document entirely; the sandbox and CSP of this origin still apply.
      document.open();
      document.write(message.content);
      document.close();
      return;
    case 'react': {
      resetRoot();
      const [{ renderReact }] = await Promise.all([import('./react.ts'), ensureTailwind()]);
      unmountReact = renderReact(message.content, root, (error) => post({ type: 'error', message: error }));
      return;
    }
    case 'svg':
      resetRoot();
      root.className = 'center';
      root.innerHTML = message.content;
      return;
    case 'mermaid': {
      resetRoot();
      root.className = 'center';
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, theme: message.theme === 'dark' ? 'dark' : 'neutral', securityLevel: 'strict' });
      const { svg } = await mermaid.render(`m${Date.now()}`, message.content);
      root.innerHTML = svg;
      return;
    }
    case 'markdown':
    case 'code': {
      resetRoot();
      root.className = 'md';
      const { marked } = await import('marked');
      root.innerHTML = await marked.parse(message.artifactType === 'code' ? '```\n' + message.content + '\n```' : message.content);
      return;
    }
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  const data = event.data as Partial<RenderMessage> | null;
  if (data?.type !== 'render' || typeof data.content !== 'string') return;
  render(data as RenderMessage).then(
    () => post({ type: 'rendered' }),
    (error: unknown) => post({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
  );
});
window.addEventListener('error', (e) => post({ type: 'error', message: e.message }));
post({ type: 'ready' });
