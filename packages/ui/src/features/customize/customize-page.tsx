/**
 * Customize (Chat and Code sidebars): what extends the assistant, in one place. The tabs are the Settings pages;
 * connectors and plugins are admin settings, so everyone else sees them read-only.
 */
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Tab, Tabs, TabsList, TabsPanel } from '../../components/ui/index.ts';
import { useAccount } from '../../lib/queries.ts';
import { ConnectorsOverview, ConnectorsPage } from '../settings/connectors-page.tsx';
import { PluginsPage } from '../settings/plugins-page.tsx';
import { SkillsPage } from '../settings/skills-page.tsx';

export const CUSTOMIZE_TABS = ['skills', 'connectors', 'plugins'] as const;
export type CustomizeTab = (typeof CUSTOMIZE_TABS)[number];

export interface CustomizeSearch {
  tab?: CustomizeTab;
  /** Opened from Code's sidebar, which stays on screen. */
  mode?: 'code';
}

export function CustomizePage() {
  const search: CustomizeSearch = useSearch({ from: '/customize' });
  const navigate = useNavigate();
  const { account } = useAccount();
  const admin = account?.role === 'admin';

  return (
    <>
      <div className="app-drag h-(--at-layout-header-height) shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div className="mx-auto max-w-240">
          <h1 className="mt-1.5 font-serif text-page-title text-fg">Customize</h1>
          <p className="mt-1 text-body text-fg-muted">
            Skills Atelier can use, connectors to other services, and plugins that bundle them.
          </p>
          <Tabs
            value={search.tab ?? 'skills'}
            onValueChange={(tab: CustomizeTab) =>
              void navigate({ to: '/customize', search: { ...search, tab }, replace: true })
            }
          >
            <TabsList className="mt-6 border-b border-line-subtle">
              <Tab value="skills">Skills</Tab>
              <Tab value="connectors">Connectors</Tab>
              <Tab value="plugins">Plugins</Tab>
            </TabsList>
            <TabsPanel value="skills" className="pt-8">
              <SkillsPage />
            </TabsPanel>
            <TabsPanel value="connectors" className="pt-8">
              {admin ? <ConnectorsPage /> : <ConnectorsOverview />}
            </TabsPanel>
            <TabsPanel value="plugins" className="pt-8">
              <PluginsPage readOnly={!admin} />
            </TabsPanel>
          </Tabs>
        </div>
      </div>
    </>
  );
}
