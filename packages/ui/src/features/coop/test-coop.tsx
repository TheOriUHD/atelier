/**
 * Fixtures for the co-op tests: people, a co-op state, a session summary, and a render that gives the component a
 * session page's co-op view (`useCoop` over the fake backend's `coop.state`) inside a router. Tests mock `rpc()` with
 * settings/test-backend.ts as usual.
 */
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { DEFAULT_COOP_SETTINGS, type CoopState, type Message, type Participant, type SessionSummary } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import type { LiveSessionState } from '../../lib/live-session.ts';
import { backend } from '../settings/test-backend.ts';
import { CoopContext, useCoop } from './coop.ts';

export function person(id: string, name: string, role: Participant['role'], extra: Partial<Participant> = {}): Participant {
  return { id, kind: id.startsWith('peer:') ? 'peer' : 'account', name, avatar: null, role, models: 'host', model: null, trusted: false, online: true, joinedAt: 0, ...extra };
}

export const ADA = person('account:ada', 'Ada', 'host');
export const BEN = person('peer:ben', 'Ben', 'editor');

export function coopState(extra: Partial<CoopState> = {}): CoopState {
  return {
    sessionId: 's1',
    me: ADA.id,
    role: 'host',
    participants: [ADA, BEN],
    settings: { ...DEFAULT_COOP_SETTINGS },
    invite: null,
    knocking: [],
    via: 'relay',
    hostAway: false,
    ended: false,
    sharedUse: null,
    ...extra,
  };
}

export function summary(extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    mode: 'code',
    workspaceId: null,
    permissionMode: null,
    title: 'Minecraft shader',
    projectId: null,
    model: 'fake/m',
    effort: null,
    connectorsOff: [],
    research: false,
    status: 'idle',
    pinnedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

export const hosting = summary({ coop: { role: 'host', hostName: 'Ada', participants: 2 } });
export const guestOf = summary({ id: 'coop_room_s1', coop: { role: 'editor', hostName: 'Ada', participants: 2, mirror: true } });

export const message = (id: string, role: Message['role'], extra: Partial<Message> = {}): Message => ({
  id,
  sessionId: 's1',
  parentId: null,
  role,
  parts: [],
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: 0,
  ...extra,
});

export function liveState(session: SessionSummary | null, extra: Partial<LiveSessionState> = {}): LiveSessionState {
  return {
    status: 'ready',
    error: null,
    session,
    messages: [],
    siblings: {},
    streamingMessageId: null,
    toolInputs: {},
    context: null,
    compacting: false,
    queued: null,
    phase: null,
    outbox: [],
    artifacts: {},
    pending: null,
    todos: [],
    tasks: [],
    toolOutput: {},
    suggestion: null,
    seq: 1,
    ...extra,
  };
}

function Harness({ live, children }: { live: LiveSessionState; children: ReactNode }) {
  const coop = useCoop(live);
  return <CoopContext.Provider value={coop}>{children}</CoopContext.Provider>;
}

/**
 * Renders `ui` as part of a session page whose co-op state is `state` (null: co-op off), at `/code/<id>`, with routes
 * for the homes it may navigate to. Returns the router, to read where it went.
 */
export function renderCoop(ui: ReactNode | ((live: LiveSessionState) => ReactNode), { live, state }: { live: LiveSessionState; state: CoopState | null | (() => CoopState | null) }) {
  backend.handlers['coop.state'] = () => (typeof state === 'function' ? state() : state);
  const root = createRootRoute({
    component: () => (
      <>
        <Harness live={live}>{typeof ui === 'function' ? ui(live) : ui}</Harness>
        <Outlet />
      </>
    ),
  });
  const routes = ['/', '/code', '/work', '/chat/$sessionId', '/code/$sessionId', '/work/$sessionId'].map((path) => createRoute({ getParentRoute: () => root, path, component: () => null }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [`/code/${live.session?.id ?? 's1'}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}
