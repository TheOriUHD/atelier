import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpDown, FolderClosed, Pin, Search } from 'lucide-react';
import type { Project } from '@atelier/protocol';
import { Button, Icon, IconButton, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, Spinner, TextField } from '../../components/ui/index.ts';
import { useProjects } from '../../lib/queries.ts';
import { ProjectDetailsDialog } from './project-dialogs.tsx';
import { projectMeta, visibleProjects, type ProjectSort } from './projects.ts';

export function ProjectsPage() {
  const { data: projects } = useProjects();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sort, setSort] = useState<ProjectSort>('updated');
  const [creating, setCreating] = useState(false);
  const shown = visibleProjects(projects ?? [], query, sort);

  return (
    <>
      <div className="app-drag h-(--at-layout-header-height) shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 max-md:px-4">
        <div className="@container mx-auto max-w-240">
          <div className="mt-1.5 flex items-center gap-2">
            <h1 className="flex-1 font-serif text-page-title text-fg">Projects</h1>
            {searchOpen || query ? (
              <TextField
                aria-label="Search projects"
                placeholder="Search projects"
                value={query}
                autoFocus
                className="w-60"
                onChange={(e) => setQuery(e.target.value)}
                onBlur={() => setSearchOpen(false)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return;
                  setQuery('');
                  setSearchOpen(false);
                }}
              />
            ) : (
              <IconButton icon={Search} label="Search projects" iconSize="md" disabled={!projects?.length} onClick={() => setSearchOpen(true)} />
            )}
            <Menu>
              <MenuTrigger render={<IconButton icon={ArrowUpDown} label="Sort" iconSize="md" disabled={!projects?.length} />} />
              <MenuContent align="end" className="w-52">
                <MenuRadioGroup value={sort} onValueChange={(value: ProjectSort) => setSort(value)}>
                  <MenuRadioItem value="updated" closeOnClick>Recently updated</MenuRadioItem>
                  <MenuRadioItem value="name" closeOnClick>Name</MenuRadioItem>
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
            <Button variant="primary" className="ml-2" onClick={() => setCreating(true)}>
              New project
            </Button>
          </div>
          {!projects ? (
            <Spinner className="mx-auto mt-24" />
          ) : projects.length === 0 ? (
            <EmptyState onCreate={() => setCreating(true)} />
          ) : shown.length === 0 ? (
            <p className="mt-24 text-center text-body text-fg-muted">No projects match “{query.trim()}”.</p>
          ) : (
            <ul className="mt-12 grid grid-cols-1 gap-4 @xl:grid-cols-2">
              {shown.map((p) => (
                <li key={p.id}>
                  <ProjectCard project={p} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <ProjectDetailsDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function ProjectCard({ project }: { project: Project & { sessionCount: number; fileCount: number } }) {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className="flex h-[142px] flex-col rounded-2xl border border-line p-4 outline-none transition-colors duration-(--at-duration-fast) focus-ring hover:bg-fill-ghost-hover"
    >
      <span className="flex items-center gap-2">
        <span className="truncate text-body-strong text-fg">{project.name}</span>
        {project.pinnedAt && <Icon icon={Pin} label="Pinned" className="size-3.5 text-fg-muted" />}
      </span>
      {project.description && <span className="mt-2 line-clamp-2 text-body text-fg-secondary">{project.description}</span>}
      <span className="mt-auto truncate text-caption text-fg-muted">{projectMeta(project)}</span>
    </Link>
  );
}

function EmptyState({ onCreate }: { onCreate(): void }) {
  return (
    <div className="mt-12 flex items-center gap-4 rounded-2xl bg-fill-ghost-hover p-4 max-md:flex-col max-md:items-start">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-bg text-fg-secondary inset-ring inset-ring-line">
        <Icon icon={FolderClosed} size="md" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-section-heading text-fg">Start a project</h2>
        <p className="mt-0.5 text-body text-fg-muted">Keep related chats together and give every new one the same instructions and files.</p>
      </div>
      <Button variant="primary" size="sm" onClick={onCreate}>
        New project
      </Button>
    </div>
  );
}
