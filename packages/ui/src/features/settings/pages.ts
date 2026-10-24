import {
  Blocks,
  Box,
  Brain,
  BriefcaseBusiness,
  ChartColumn,
  CircleUserRound,
  Cloud,
  CodeXml,
  Cpu,
  FolderClosed,
  Keyboard,
  KeyRound,
  Laptop,
  Plug,
  Puzzle,
  ScrollText,
  Server,
  Wrench,
  Settings as SettingsIcon,
  Shield,
  SquareCode,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { desktop } from '../../lib/platform.ts';
import { isLocal } from '../auth/screen-lock.ts';

export type SettingsPageId =
  | 'general'
  | 'shortcuts'
  | 'account'
  | 'privacy'
  | 'memory'
  | 'usage'
  | 'code'
  | 'folders'
  | 'cloud'
  | 'personal-models'
  | 'skills'
  | 'system'
  | 'providers'
  | 'models'
  | 'capabilities'
  | 'admin-code'
  | 'connectors'
  | 'plugins'
  | 'secrets'
  | 'users'
  | 'server'
  | 'developer';

export interface SettingsPage {
  id: SettingsPageId;
  label: string;
  icon: LucideIcon;
  /** Nav group label. The Admin group is only shown to admins. */
  group: 'Settings' | 'Admin';
  /** Shown only where it works; the page's rows go with it. */
  available?(): boolean;
}

/** Nav order. Only pages that work end to end are listed. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'general', label: 'General', icon: SettingsIcon, group: 'Settings' },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, group: 'Settings' },
  { id: 'account', label: 'Account', icon: CircleUserRound, group: 'Settings' },
  { id: 'privacy', label: 'Privacy', icon: Shield, group: 'Settings' },
  { id: 'memory', label: 'Memory', icon: Brain, group: 'Settings' },
  { id: 'usage', label: 'Usage', icon: ChartColumn, group: 'Settings' },
  { id: 'code', label: 'Code', icon: CodeXml, group: 'Settings' },
  { id: 'folders', label: 'Folders', icon: FolderClosed, group: 'Settings' },
  // GitHub and the codespaces that become folders.
  { id: 'cloud', label: 'Cloud', icon: Cloud, group: 'Settings' },
  // The person's own model servers and ChatGPT Chat on their computers, reached through the desktop app there.
  { id: 'personal-models', label: 'Your models', icon: Cpu, group: 'Settings', available: () => !isLocal() },
  { id: 'skills', label: 'Skills', icon: ScrollText, group: 'Settings' },
  // This computer: the desktop app's version and updates, launch at login, data folder.
  { id: 'system', label: 'System', icon: Laptop, group: 'Settings', available: () => !!desktop },
  { id: 'providers', label: 'Providers', icon: Plug, group: 'Admin' },
  { id: 'models', label: 'Models', icon: Box, group: 'Admin' },
  { id: 'capabilities', label: 'Capabilities', icon: BriefcaseBusiness, group: 'Admin' },
  // Everyone's Code sessions: permission rules and the system AGENTS.md.
  { id: 'admin-code', label: 'Code', icon: SquareCode, group: 'Admin' },
  { id: 'connectors', label: 'Connectors', icon: Blocks, group: 'Admin' },
  { id: 'plugins', label: 'Plugins', icon: Puzzle, group: 'Admin' },
  { id: 'secrets', label: 'Keys & secrets', icon: KeyRound, group: 'Admin' },
  { id: 'users', label: 'Users', icon: Users, group: 'Admin' },
  { id: 'server', label: 'Server', icon: Server, group: 'Admin' },
  { id: 'developer', label: 'Developer', icon: Wrench, group: 'Admin' },
];

/** The pages this person may open here: admins see everything, everyone else only their own settings. */
export function visiblePages(admin: boolean): readonly SettingsPage[] {
  return SETTINGS_PAGES.filter((p) => (admin || p.group !== 'Admin') && (p.available?.() ?? true));
}

/** The page for a `?settings=` value; unknown values, and admin pages for non-admins, fall back to General. */
export function settingsPage(id: string | undefined, admin: boolean): SettingsPage {
  return visiblePages(admin).find((p) => p.id === id) ?? SETTINGS_PAGES[0]!;
}
