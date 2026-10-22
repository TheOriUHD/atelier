/** The Cowork page (Chat sidebar › Cowork): a new task in a folder, and the person's tasks by folder under the stats. */
import { FolderGroups } from '../../app/session-rows.tsx';
import { useSessions } from '../../lib/queries.ts';
import { FolderHome } from '../code/code-home.tsx';

export function CoworkHome() {
  const { data: tasks } = useSessions({ mode: 'work' });
  return (
    <FolderHome mode="work">
      {/* As far below the greeting as the stats card when there is none, else close under the card. */}
      <section aria-label="Your tasks" className="mt-2 mb-6 [h1+&]:mt-14">
        {tasks?.length === 0 ? (
          <p className="text-body text-fg-muted">
            Cowork works through longer tasks in a folder and leaves the files it makes there. Your tasks show here, by
            folder.
          </p>
        ) : (
          <FolderGroups mode="work" />
        )}
      </section>
    </FolderHome>
  );
}
