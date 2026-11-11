import { createHashHistory, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { AppError } from './app-error.tsx';
import { AppShell } from './app-shell.tsx';
import { recalledTab, startHash } from './last-tab.ts';
import { HomePage } from '../features/chat/home-page.tsx';
import { ChatPage } from '../features/chat/chat-page.tsx';
import { ProjectsPage } from '../features/projects/projects-page.tsx';
import { ProjectPage } from '../features/projects/project-view.tsx';
import { FolderHome } from '../features/code/code-home.tsx';
import type { FolderSearch } from '../features/code/workspaces.ts';
import { CodePage } from '../features/code/code-page.tsx';
import { WorkPage } from '../features/work/work-page.tsx';
import { LiveViewPage } from '../features/work/live-view.tsx';
import { CoworkHome } from '../features/work/cowork-home.tsx';
import { ArtifactsPage } from '../features/artifacts/artifacts-page.tsx';
import { ImagesPage } from '../features/images/images-page.tsx';
import { CUSTOMIZE_TABS, CustomizePage, type CustomizeSearch } from '../features/customize/customize-page.tsx';
import { JoinPage } from '../features/coop/join-page.tsx';
import { TerminalLinkPage, type TerminalLinkSearch } from '../features/auth/terminal-link-page.tsx';

/** Overlays addressable from any page: `?settings=providers&row=providers.add`. */
export interface RootSearch {
  settings?: string;
  row?: string;
  /** Settings › Memory: the entry shown (`?settings=memory&memory=<id>`). */
  memory?: string;
}

const rootRoute = createRootRoute({
  component: AppShell,
  validateSearch: (search: Record<string, unknown>): RootSearch => ({
    ...(typeof search.settings === 'string' ? { settings: search.settings } : {}),
    ...(typeof search.row === 'string' ? { row: search.row } : {}),
    ...(typeof search.memory === 'string' ? { memory: search.memory } : {}),
  }),
});

/** `?temporary=true`: the new chat will be a temporary one. */
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): { temporary?: boolean } => (search.temporary === true || search.temporary === 'true' ? { temporary: true } : {}),
});
/** Each conversation is a page of its own: switching chats must not carry the last one's panels or previews over. */
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: '/chat/$sessionId', component: ChatPage, remountDeps: ({ params }) => params.sessionId });
const folderSearch = (search: Record<string, unknown>): FolderSearch => ({
  ...(typeof search.workspace === 'string' ? { workspace: search.workspace } : {}),
  ...(typeof search.host === 'string' ? { host: search.host } : {}),
  ...(typeof search.group === 'string' ? { group: search.group } : {}),
});
const workRoute = createRoute({ getParentRoute: () => rootRoute, path: '/work', component: CoworkHome, validateSearch: folderSearch });
const workSessionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/work/$sessionId', component: WorkPage, remountDeps: ({ params }) => params.sessionId });
/** A task's live view, popped out into a small window of its own (desktop: `openLiveView`). */
const liveRoute = createRoute({ getParentRoute: () => rootRoute, path: '/live/$sessionId', component: LiveViewPage, remountDeps: ({ params }) => params.sessionId });
const codeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/code', component: () => <FolderHome mode="code" />, validateSearch: folderSearch });
/** `?split=<session>`: a second Code session beside this one (split view). */
const codeSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/code/$sessionId',
  component: CodePage,
  validateSearch: (search: Record<string, unknown>): { split?: string } => (typeof search.split === 'string' ? { split: search.split } : {}),
});
const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/projects', component: ProjectsPage });
const projectRoute = createRoute({ getParentRoute: () => rootRoute, path: '/projects/$projectId', component: ProjectPage });
const artifactsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/artifacts', component: ArtifactsPage });
const imagesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/images', component: ImagesPage });
const customizeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/customize',
  component: CustomizePage,
  validateSearch: (search: Record<string, unknown>): CustomizeSearch => ({
    ...(CUSTOMIZE_TABS.includes(search.tab as never) ? { tab: search.tab as CustomizeSearch['tab'] } : {}),
    ...(search.mode === 'code' ? { mode: 'code' as const } : {}),
  }),
});
/**
 * A co-op invite (`#/join/v1.<room>.<secret>.<meta>`): the desktop app lands here from `atelier://join#…` links
 * (apps/desktop/src/main.ts sets the hash), and so does a link pasted into the address.
 */
const joinRoute = createRoute({ getParentRoute: () => rootRoute, path: '/join/$fragment', component: JoinPage, remountDeps: ({ params }) => params.fragment });
/** `#/link?code=…`: approving a terminal that signs in through the browser (`atelier login`). */
const linkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/link',
  component: TerminalLinkPage,
  validateSearch: (search: Record<string, unknown>): TerminalLinkSearch => (typeof search.code === 'string' ? { code: search.code } : {}),
});
// The sign-in gate handles invite links; someone already signed in just lands at home.
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true });
  },
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  chatRoute,
  workRoute,
  workSessionRoute,
  liveRoute,
  codeRoute,
  codeSessionRoute,
  projectsRoute,
  projectRoute,
  artifactsRoute,
  imagesRoute,
  customizeRoute,
  joinRoute,
  linkRoute,
  inviteRoute,
]);

// An app that starts on its bare home opens in the tab it was last in.
if (typeof window !== 'undefined') {
  const start = startHash(window.location.hash, recalledTab());
  if (start) window.history.replaceState(null, '', start);
}

// Hash history: the desktop app is served from app:// and the web build from any base path.
export const router = createRouter({ routeTree, history: createHashHistory(), scrollRestoration: false, defaultErrorComponent: AppError });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
