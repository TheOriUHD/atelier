/** design/components.md › TaskProgressList: the task's steps (its TodoWrite list) and how far it got. */
import type { Todo } from '@atelier/protocol';
import { TodoList } from '../code/todo-widget.tsx';

export function TaskProgressList({ todos, running }: { todos: Todo[]; running: boolean }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <section aria-label="Progress" className="flex flex-col gap-1.5">
      <h2 className="flex h-5 items-center justify-between text-footnote text-fg-muted">
        Progress
        {todos.length > 0 && (
          <span className="tabular-nums">
            {done} of {todos.length}
          </span>
        )}
      </h2>
      {todos.length > 0 ? (
        <TodoList todos={todos} running={running} wrap />
      ) : (
        <p className="text-body text-fg-muted">{running ? 'The steps show here once the task is planned.' : 'This task listed no steps.'}</p>
      )}
    </section>
  );
}
