/**
 * React artifacts, loaded only when one is rendered: React, Recharts, Lucide and Sucrase are most of the runtime's
 * size, and HTML, SVG, Mermaid and Markdown artifacts need none of them.
 */
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
import * as Recharts from 'recharts';
import * as Lucide from 'lucide-react';
import { transform } from 'sucrase';

const modules: Record<string, unknown> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JsxRuntime,
  recharts: Recharts,
  'lucide-react': Lucide,
};

/** Renders the artifact's component into `root`; returns how to unmount it. Errors while rendering go to `onError`. */
export function renderReact(source: string, root: HTMLElement, onError: (message: string) => void): () => void {
  const code = transform(source, { transforms: ['typescript', 'jsx', 'imports'], jsxRuntime: 'automatic', production: true }).code;
  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string) => {
    if (!(name in modules)) throw new Error(`"${name}" is not available in artifacts. Available: ${Object.keys(modules).join(', ')}`);
    return modules[name];
  };
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  const Component = (module.exports.default ?? Object.values(module.exports).find((v) => typeof v === 'function')) as React.ComponentType | undefined;
  if (!Component) throw new Error('The artifact must export a React component (export default function App() { … }).');

  class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
    override state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error) {
      onError(error.message);
      return { error };
    }
    override render() {
      return this.state.error ? null : this.props.children;
    }
  }

  const reactRoot = ReactDOMClient.createRoot(root);
  reactRoot.render(React.createElement(ErrorBoundary, null, React.createElement(Component)));
  return () => reactRoot.unmount();
}
