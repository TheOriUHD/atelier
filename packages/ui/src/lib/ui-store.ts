import { create } from 'zustand';
import { isNarrow } from './narrow.ts';

const SIDEBAR_KEY = 'atelier.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

export interface ArtifactPanelState {
  sessionId: string;
  artifactId: string;
  /** null = follow the latest version. */
  version: number | null;
  view: 'preview' | 'code';
  expanded: boolean;
}

interface UiState {
  sidebarCollapsed: boolean;
  /** Narrow screens: the sidebar shows as a drawer over the page. */
  drawerOpen: boolean;
  paletteOpen: boolean;
  artifact: ArtifactPanelState | null;
  /** The split view cell the person works in (a session id, or the new session's place); the first when not shown. */
  activeCell: string | null;
  /** Collapses or expands the sidebar; on narrow screens, opens or closes the drawer instead. */
  toggleSidebar(): void;
  setDrawerOpen(open: boolean): void;
  setPaletteOpen(open: boolean): void;
  setActiveCell(id: string | null): void;
  openArtifact(sessionId: string, artifactId: string): void;
  updateArtifact(patch: Partial<ArtifactPanelState>): void;
  closeArtifact(): void;
}

export const useUi = create<UiState>((set) => ({
  sidebarCollapsed: readCollapsed(),
  drawerOpen: false,
  paletteOpen: false,
  artifact: null,
  activeCell: null,
  setActiveCell: (activeCell) => set({ activeCell }),
  toggleSidebar: () =>
    set((s) => {
      if (isNarrow()) return { drawerOpen: !s.drawerOpen };
      try {
        localStorage.setItem(SIDEBAR_KEY, s.sidebarCollapsed ? '0' : '1');
      } catch {
        // Storage unavailable; the toggle still works for this session.
      }
      return { sidebarCollapsed: !s.sidebarCollapsed };
    }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  // The palette replaces the drawer it may have been opened from.
  setPaletteOpen: (paletteOpen) => set(paletteOpen ? { paletteOpen, drawerOpen: false } : { paletteOpen }),
  openArtifact: (sessionId, artifactId) => set({ artifact: { sessionId, artifactId, version: null, view: 'preview', expanded: false } }),
  updateArtifact: (patch) => set((s) => (s.artifact ? { artifact: { ...s.artifact, ...patch } } : {})),
  closeArtifact: () => set({ artifact: null }),
}));
