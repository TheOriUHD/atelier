/** TanStack Query hooks over the RPC contract; backend events keep caches fresh without polling. */
import { useEffect } from 'react';
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { defaultUserPrefs, type DiffCompare, type Mode, type ProviderType, type SessionSummary, type Settings, type SettingsLayer, type SettingsPath, type SidebarView, type UserPrefs } from '@atelier/protocol';
import { setPath } from './json-path.ts';
import { rpc } from './rpc.ts';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 } },
});

export const keys = {
  settings: ['settings'] as const,
  sessions: (mode?: Mode, projectId?: string, query?: string, archived: 'active' | 'archived' | 'all' = 'active') => ['sessions', mode ?? null, projectId ?? null, query ?? '', archived] as const,
  /** The person's own sidebar groups. */
  groups: ['groups'] as const,
  models: ['models'] as const,
  providers: ['providers'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  secrets: ['secrets'] as const,
  appInfo: ['appInfo'] as const,
  prefs: ['prefs'] as const,
  account: ['account'] as const,
  authSessions: ['account', 'sessions'] as const,
  devices: ['account', 'devices'] as const,
  passkeys: ['account', 'passkeys'] as const,
  screenLock: ['screenLock'] as const,
  /** Every usage summary; each is keyed further by period and scope. */
  usage: ['usage'] as const,
  github: ['github'] as const,
  codespaces: ['codespaces'] as const,
  githubRepos: ['github', 'repos'] as const,
  /** Which web search engines answer, and which are being limited. */
  searchStatus: ['search', 'status'] as const,
  /** The ChatGPT subscription's sign-in (a browser on the desktop, a device code on a server). */
  chatgpt: ['chatgpt'] as const,
  copilot: ['copilot'] as const,
  /** Connecting OpenRouter in the browser. */
  openrouter: ['openrouter'] as const,
  /** The person's SSH connections (desktop). */
  ssh: ['ssh'] as const,
  users: ['users'] as const,
  invites: ['invites'] as const,
  systemInstructions: ['systemInstructions'] as const,
  workspaces: ['workspaces'] as const,
  /** Every skills list; each is keyed further by the folder whose project skills it includes. */
  skills: ['skills'] as const,
  plugins: ['plugins'] as const,
  /** Connectors' live status; `mcp.changed` replaces it. */
  mcp: ['mcp'] as const,
  /** The person's memory (Settings › Memory); `memory.changed` reloads it. */
  memory: ['memory'] as const,
  /** Everything read from one workspace (files, git); invalidated after the agent's tool calls. */
  workspace: (id: string) => ['workspace', id] as const,
};

/** Wires backend events into the query cache once, at app start. */
export function useLiveQueries(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const offs = [
      rpc().on('settings.changed', (snapshot) => qc.setQueryData(keys.settings, snapshot)),
      rpc().on('prefs.changed', (prefs) => {
        qc.setQueryData(keys.prefs, prefs);
        void qc.invalidateQueries({ queryKey: keys.ssh });
      }),
      rpc().on('account.changed', (user) => qc.setQueryData(keys.account, user)),
      rpc().on('models.changed', (models) => qc.setQueryData(keys.models, models)),
      rpc().on('providers.changed', (status) => qc.setQueryData(keys.providers, status)),
      rpc().on('sessions.changed', (summary) => {
        qc.setQueriesData<SessionSummary[]>({ queryKey: ['sessions'] }, (list) => {
          if (!list) return list;
          const i = list.findIndex((s) => s.id === summary.id);
          if (i === -1) return undefined; // unknown position: refetch
          const next = list.slice();
          // Events don't carry what only lists compute (`produced`); keep it until the refetch.
          next[i] = { ...list[i], ...summary };
          return next;
        });
        void qc.invalidateQueries({ queryKey: ['sessions'] });
      }),
      rpc().on('sessions.removed', () => void qc.invalidateQueries({ queryKey: ['sessions'] })),
      rpc().on('groups.changed', (list) => {
        qc.setQueryData(keys.groups, list);
        void qc.invalidateQueries({ queryKey: ['sessions'] });
      }),
      rpc().on('workspaces.changed', (list) => qc.setQueryData(keys.workspaces, list)),
      rpc().on('extensions.changed', () => {
        for (const queryKey of [keys.skills, keys.plugins, ['slash']]) void qc.invalidateQueries({ queryKey });
      }),
      rpc().on('memory.changed', () => void qc.invalidateQueries({ queryKey: keys.memory })),
      rpc().on('projects.changed', () => {
        void qc.invalidateQueries({ queryKey: keys.projects });
        void qc.invalidateQueries({ queryKey: ['project'] });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [qc]);
}

/** The person's memory entries, kept current by `memory.changed`. */
export function useMemory() {
  return useQuery({ queryKey: keys.memory, queryFn: async () => (await rpc().call('memory.list', {})).entries });
}

/** Connectors and their live status (asking starts connecting the ones not tried yet), kept current by `mcp.changed`. */
export function useMcpStatus() {
  const qc = useQueryClient();
  useEffect(() => rpc().on('mcp.changed', (list) => qc.setQueryData(keys.mcp, list)), [qc]);
  return useQuery({ queryKey: keys.mcp, queryFn: () => rpc().call('mcp.status', {}), staleTime: 0 }).data;
}

export function useSettings() {
  const q = useQuery({ queryKey: keys.settings, queryFn: () => rpc().call('settings.get', {}) });
  return { ...q, settings: q.data?.effective as Settings | undefined };
}

/** The type of a configured provider (anthropic, openai, chatgpt, …), or null when it isn't one. */
export function useProviderType(providerId: string | undefined): ProviderType | null {
  const { settings } = useSettings();
  return (providerId && settings?.providers.find((p) => p.id === providerId)?.type) || null;
}

export function useSetSetting() {
  return useMutation({
    mutationFn: (input: { path: SettingsPath; value: unknown; layer?: SettingsLayer }) =>
      rpc().call('settings.set', { layer: input.layer ?? 'global', path: input.path, value: input.value }),
  });
}

/** The person's own sidebar groups (Code and Cowork). */
export function useGroups({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: keys.groups, queryFn: () => rpc().call('groups.list', {}), enabled });
}

/** How the sidebar's session lists are shown, and a way to change one part of it. */
export function useSidebarView(): { view: SidebarView; set(patch: Partial<SidebarView>): void } {
  const { prefs } = usePrefs();
  const setPref = useSetPref();
  const view = prefs?.sidebar ?? defaultUserPrefs().sidebar;
  return { view, set: (patch) => Object.entries(patch).forEach(([key, value]) => setPref.mutate({ path: ['sidebar', key], value })) };
}

/** The signed-in person's preferences (appearance, how to be addressed, instructions, preferred models). */
export function usePrefs() {
  const q = useQuery({ queryKey: keys.prefs, queryFn: () => rpc().call('prefs.get', {}) });
  return { ...q, prefs: q.data };
}

/** Writes one preference. The cache shows it before the backend answers; the answer replaces it. */
export function useSetPref() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: SettingsPath; value: unknown }) => rpc().call('prefs.set', input),
    onMutate: ({ path, value }) => qc.setQueryData<UserPrefs>(keys.prefs, (prefs) => prefs && setPath(prefs, path, value)),
    onSuccess: (prefs) => qc.setQueryData(keys.prefs, prefs),
    onError: () => void qc.invalidateQueries({ queryKey: keys.prefs }),
  });
}

/** Removes one preference, so its default (or the system's choice) applies again. */
export function useResetPref() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: SettingsPath }) => rpc().call('prefs.reset', input),
    onSuccess: (prefs) => qc.setQueryData(keys.prefs, prefs),
  });
}

/** The signed-in user. The sign-in gate seeds it; `account.changed` keeps it current. */
export function useAccount() {
  const q = useQuery({ queryKey: keys.account, queryFn: () => rpc().call('account.get', {}) });
  return { ...q, account: q.data };
}

export function useSessions(filter: { mode?: Mode; projectId?: string; query?: string; archived?: 'active' | 'archived' | 'all' } = {}) {
  return useQuery({
    queryKey: keys.sessions(filter.mode, filter.projectId, filter.query, filter.archived),
    // The backend never lists temporary chats; this keeps one out should an event or a stale page carry it.
    queryFn: async () => (await rpc().call('sessions.list', { ...filter, limit: 200 })).filter((s) => !s.temporary),
    staleTime: 0,
  });
}

export function useModels() {
  return useQuery({ queryKey: keys.models, queryFn: () => rpc().call('models.list', {}) });
}

export function useProviderStatus() {
  return useQuery({ queryKey: keys.providers, queryFn: () => rpc().call('providers.status', {}) });
}

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: () => rpc().call('projects.list', {}) });
}

export function useProject(id: string) {
  return useQuery({ queryKey: keys.project(id), queryFn: () => rpc().call('projects.get', { id }) });
}

export function useAppInfo() {
  return useQuery({ queryKey: keys.appInfo, queryFn: () => rpc().call('app.info', {}) });
}

/** The person's workspaces (folders on their devices), with whether each can run tools right now. */
export function useWorkspaces() {
  return useQuery({ queryKey: keys.workspaces, queryFn: () => rpc().call('workspaces.list', {}) });
}

/** One level of a workspace's file tree; `dir` is relative to its root ('' for the root). */
export function useWorkspaceFiles(workspaceId: string, dir: string) {
  return useQuery({ queryKey: [...keys.workspace(workspaceId), 'files', dir], queryFn: () => rpc().call('workspaces.files', { workspaceId, dir }) });
}

export function useWorkspaceFile(workspaceId: string, path: string) {
  return useQuery({ queryKey: [...keys.workspace(workspaceId), 'file', path], queryFn: () => rpc().call('workspaces.readFile', { workspaceId, path }) });
}

/** Branch and changed files; null outside a git repository. */
export function useGitStatus(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: [...keys.workspace(workspaceId ?? ''), 'git'],
    queryFn: () => rpc().call('workspaces.gitStatus', { workspaceId: workspaceId! }),
    enabled: !!workspaceId,
  });
}

/** The working tree as one unified diff against what `compare` names (HEAD by default, untracked files included). */
export function useWorkspaceDiff(workspaceId: string, compare: DiffCompare = 'head', sessionId?: string) {
  return useQuery({
    queryKey: [...keys.workspace(workspaceId), 'diff', compare, sessionId ?? null],
    queryFn: () => rpc().call('workspaces.diff', { workspaceId, compare, ...(sessionId ? { sessionId } : {}) }),
  });
}

/** Lines in the workspace's files containing `query` (the Files pane's `?` search). */
export function useWorkspaceGrep(workspaceId: string, query: string) {
  return useQuery({
    queryKey: [...keys.workspace(workspaceId), 'grep', query],
    queryFn: () => rpc().call('workspaces.grep', { workspaceId, query }),
    enabled: !!query,
    placeholderData: (previous) => previous,
  });
}

/** Workspace files whose names (or paths) contain `query`, best first (the Files pane's filter). */
export function useFindFiles(workspaceId: string, query: string) {
  return useQuery({
    queryKey: [...keys.workspace(workspaceId), 'find', query],
    queryFn: () => rpc().call('workspaces.findFiles', { workspaceId, query }),
    enabled: !!query,
    placeholderData: (previous) => previous,
  });
}
