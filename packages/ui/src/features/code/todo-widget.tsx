/** The session's TodoWrite list (design/components.md › TodoWidget): rows 28 with a status icon and the task. */
import { useState } from 'react';
import { Circle, CircleCheck, CircleDot, ListTodo } from 'lucide-react';
import type { Todo } from '@atelier/protocol';
import { Icon, Spinner, cn } from '../../components/ui/index.ts';
import { Chevron } from '../chat/parts.tsx';

const STATUS_LABEL: Record<Todo['status'], string> = { pending: 'Pending', in_progress: 'In progress', completed: 'Done' };

/**
 * `running` false (the run stopped) keeps the current task from spinning on; `wrap` lets long tasks take more
 * lines instead of truncating (Work's narrow progress column).
 */
export function TodoList({ todos, running = true, wrap = false, className }: { todos: Todo[]; running?: boolean; wrap?: boolean; className?: string }) {
  return (
    <ul className={cn('flex flex-col', className)}>
      {todos.map((todo, i) => (
        <li key={i} className={cn('flex min-h-7 gap-2 text-body', wrap ? 'items-start py-1' : 'items-center')}>
          <span role="img" aria-label={STATUS_LABEL[todo.status]} className={cn('flex size-4 shrink-0 items-center justify-center', wrap && 'mt-0.5')}>
            {todo.status === 'completed' ? (
              <Icon icon={CircleCheck} className="text-success" />
            ) : todo.status === 'in_progress' ? (
              running ? <Spinner className="text-fg" /> : <Icon icon={CircleDot} className="text-fg-muted" />
            ) : (
              <Icon icon={Circle} className="text-fg-muted" />
            )}
          </span>
          <span className={cn('min-w-0', wrap ? 'break-words' : 'truncate', todo.status === 'completed' ? 'text-fg-muted line-through' : 'text-fg')}>
            {todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Above the composer while tasks are open: the current task and the count, opening into the list. `running` false (the run ended or failed) stops the current task's spinner. */
export function TodoWidget({ todos, running = true }: { todos: Todo[]; running?: boolean }) {
  const [open, setOpen] = useState(false);
  const done = todos.filter((t) => t.status === 'completed').length;
  if (done === todos.length) return null;
  const current = todos.find((t) => t.status === 'in_progress');
  return (
    <div className="mx-auto mb-2 w-full max-w-(--at-layout-composer-width-chat) rounded-xl bg-fill-ghost-hover px-3 py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-full items-center gap-2 rounded-sm text-left text-body text-fg-secondary outline-none focus-ring hover:text-fg"
      >
        <Icon icon={ListTodo} className="text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{current ? current.activeForm || current.content : 'Tasks'}</span>
        <span className="shrink-0 text-footnote text-fg-muted tabular-nums">
          {done} of {todos.length} done
        </span>
        <Chevron open={open} />
      </button>
      {open && <TodoList todos={todos} running={running} className="pb-1" />}
    </div>
  );
}
