// The parts of the Chrome extension APIs Atelier for Chrome uses (Manifest V3), written out so the package needs no
// @types/chrome. Shapes follow https://developer.chrome.com/docs/extensions/reference/api.

declare namespace chrome {
  export namespace runtime {
    interface Port {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: Event<(message: unknown, port: Port) => void>;
      onDisconnect: Event<(port: Port) => void>;
    }
    const lastError: { message?: string } | undefined;
    function connectNative(application: string): Port;
    function getManifest(): { version: string; name: string };
    const onStartup: Event<() => void>;
    const onInstalled: Event<(details: { reason: string }) => void>;
  }

  export interface Event<T extends (...args: never[]) => unknown> {
    addListener(callback: T): void;
    removeListener(callback: T): void;
  }

  export namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
      url?: string;
      pendingUrl?: string;
      title?: string;
      status?: 'loading' | 'complete' | 'unloaded';
      groupId: number;
      active: boolean;
    }
    function create(properties: { url?: string; active?: boolean; windowId?: number }): Promise<Tab>;
    function get(tabId: number): Promise<Tab>;
    function query(query: { groupId?: number; windowId?: number; active?: boolean }): Promise<Tab[]>;
    function update(tabId: number, properties: { url?: string; active?: boolean }): Promise<Tab>;
    function remove(tabId: number | number[]): Promise<void>;
    function goBack(tabId: number): Promise<void>;
    function group(options: { tabIds: number | number[]; groupId?: number; createProperties?: { windowId?: number } }): Promise<number>;
    const onUpdated: Event<(tabId: number, change: { status?: string; url?: string; title?: string }, tab: Tab) => void>;
    const onRemoved: Event<(tabId: number) => void>;
  }

  export namespace tabGroups {
    interface TabGroup {
      id: number;
      title?: string;
      windowId: number;
    }
    function update(groupId: number, properties: { title?: string; color?: string; collapsed?: boolean }): Promise<TabGroup>;
    function query(query: { title?: string; windowId?: number }): Promise<TabGroup[]>;
  }

  namespace debugger_ {
    interface Debuggee {
      tabId?: number;
    }
    function attach(target: Debuggee, requiredVersion: string): Promise<void>;
    function detach(target: Debuggee): Promise<void>;
    function sendCommand(target: Debuggee, method: string, params?: object): Promise<unknown>;
    const onDetach: Event<(source: Debuggee, reason: string) => void>;
  }

  export { debugger_ as debugger };

  export namespace scripting {
    interface InjectionResult<T> {
      result?: T;
      frameId: number;
    }
    function executeScript<A extends unknown[], R>(injection: {
      target: { tabId: number; allFrames?: boolean };
      func: (...args: A) => R;
      args?: A;
      world?: 'ISOLATED' | 'MAIN';
      injectImmediately?: boolean;
    }): Promise<InjectionResult<Awaited<R>>[]>;
  }

  export namespace webNavigation {
    const onCommitted: Event<(details: { tabId: number; frameId: number; url: string }) => void>;
  }

  export namespace alarms {
    function create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): void;
    const onAlarm: Event<(alarm: { name: string }) => void>;
  }

  export namespace storage {
    const session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  }
}

interface Navigator {
  userAgentData?: { brands: { brand: string; version: string }[] };
}
