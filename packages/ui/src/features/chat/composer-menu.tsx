/**
 * The composer's suggestion menus (design/components.md › SlashMenu, MentionMenu). `/` at the start lists the
 * built-in commands, then the skills and custom commands people may start; `@` in a Code composer lists the
 * workspace's files. ↑/↓ move the highlight, Enter or Tab picks, Esc closes.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { File, ScrollText, SquareSlash, type LucideIcon } from 'lucide-react';
import { Icon, cn } from '../../components/ui/index.ts';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';

export interface SlashCommand {
  name: string;
  description: string;
  /** Shown after the name, e.g. "[focus]". */
  argumentHint?: string;
  icon?: LucideIcon;
  /**
   * Built-ins run here with the text after the name, and at once when picked if they take no argument.
   * Skills and custom commands have none: they are sent as `/name args` and the backend expands them.
   */
  run?(args: string): void;
}

/** Names starting with what was typed first, then names containing it (`review` finds `plugin:review`). */
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  return [...starts, ...commands.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q))];
}

/** The `@query` the caret is in: an `@` at the start or after whitespace, then no whitespace up to the caret. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@(\S*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[1]!.length - 1, query: m[1]! } : null;
}

interface Item {
  icon: LucideIcon;
  title: string;
  /** Inserts (or runs) the item. */
  pick(): void;
  row: ReactNode;
}

const MENTION_DEBOUNCE_MS = 120;

/** The skills and custom commands people may start, for a workspace or none (the `/` menu, + › Skills). */
export function useSlashList(workspaceId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['slash', workspaceId ?? null],
    queryFn: () => rpc().call('slash.list', workspaceId ? { workspaceId } : {}),
    enabled,
    staleTime: 5_000,
  });
}

const optionId = (list: string, i: number) => `${list}-${i}`;

/**
 * The menu for what is being typed, and the keys it takes over while open. `onChange` replaces the text and
 * moves the caret.
 */
export function useComposerMenu({
  text,
  caret,
  commands,
  workspaceId,
  onChange,
}: {
  text: string;
  caret: number;
  commands: readonly SlashCommand[];
  /** Scopes skills and commands to the workspace, and turns on `@` file mentions. */
  workspaceId: string | null | undefined;
  onChange(text: string, caret: number): void;
}) {
  const id = useId();
  const slash = /^\/(\S*)$/.exec(text)?.[1];
  const mention = workspaceId && slash === undefined ? mentionAt(text, caret) : null;
  const query = useDebounced(mention?.query ?? null, MENTION_DEBOUNCE_MS);
  // Esc hides the menu until the text changes.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const trigger = slash !== undefined ? `/${slash}` : mention ? `@${mention.start}:${mention.query}` : null;
  const [highlighted, setHighlighted] = useState({ trigger, index: 0 });

  const extensions = useSlashList(workspaceId, slash !== undefined);
  const files = useQuery({
    queryKey: [...keys.workspace(workspaceId ?? ''), 'find', query],
    queryFn: () => rpc().call('workspaces.findFiles', { workspaceId: workspaceId!, query: query! }),
    enabled: !!workspaceId && query !== null,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });

  let items: Item[] = [];
  if (slash !== undefined) {
    const builtIn = new Set(commands.map((c) => c.name));
    const all: SlashCommand[] = [
      ...commands,
      ...(extensions.data ?? [])
        .filter((e) => !builtIn.has(e.name))
        .map((e) => ({ name: e.name, description: e.description, icon: e.kind === 'skill' ? ScrollText : SquareSlash, ...(e.argumentHint ? { argumentHint: e.argumentHint } : {}) })),
    ];
    items = filterCommands(all, slash).map((c) => ({
      icon: c.icon ?? SquareSlash,
      title: c.description,
      pick: () => {
        if (c.run && !c.argumentHint) {
          onChange('', 0);
          c.run('');
        } else onChange(`/${c.name} `, c.name.length + 2);
      },
      row: (
        <>
          <span className="shrink-0 text-fg">/{c.name}</span>
          {c.argumentHint && <span className="shrink-0 text-fg-muted">{c.argumentHint}</span>}
          <span className="min-w-0 flex-1 truncate text-fg-muted">{c.description}</span>
        </>
      ),
    }));
  } else if (mention && query !== null && files.data) {
    items = files.data.map((path) => ({
      icon: File,
      title: path,
      pick: () => onChange(`${text.slice(0, mention.start)}@${path} ${text.slice(caret)}`, mention.start + path.length + 2),
      row: (
        <span className="min-w-0 flex-1 truncate font-mono text-code">
          <span className="text-fg-muted">{path.slice(0, path.lastIndexOf('/') + 1)}</span>
          <span className="text-fg">{path.slice(path.lastIndexOf('/') + 1)}</span>
        </span>
      ),
    }));
  }

  const open = trigger !== null && dismissed !== text && (items.length > 0 || (!!mention && files.data !== undefined && query !== null));
  const highlight = highlighted.trigger === trigger ? Math.min(highlighted.index, Math.max(items.length - 1, 0)) : 0;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(text);
    } else if (items.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setHighlighted({ trigger, index: (highlight + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length });
    } else if (items.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing))) {
      e.preventDefault();
      items[highlight]!.pick();
    }
  };

  const menu = open && (
    <SuggestionList
      id={id}
      label={slash !== undefined ? 'Commands' : 'Files'}
      wide={slash === undefined}
      items={items}
      highlight={highlight}
      onHighlight={(index) => setHighlighted({ trigger, index })}
    />
  );
  /** For the textarea: which option the keys act on. */
  const inputProps = {
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? id : undefined,
    'aria-activedescendant': open && items.length ? optionId(id, highlight) : undefined,
  };
  return { menu, onKeyDown, inputProps };
}

/** Popover above the composer, left-aligned: 32px rows, max ~357 tall with a 28px fade while more is below. */
function SuggestionList({
  id,
  label,
  wide,
  items,
  highlight,
  onHighlight,
}: {
  id: string;
  label: string;
  wide: boolean;
  items: Item[];
  highlight: number;
  onHighlight(i: number): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = list.current;
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  };
  useLayoutEffect(measure, [items.length]);
  // Keeps the highlighted row in view by scrolling the list alone (scrollIntoView would move the page's own containers too).
  useEffect(() => {
    const el = list.current;
    const option = document.getElementById(optionId(id, highlight));
    if (!el || !option) return;
    if (option.offsetTop < el.scrollTop) el.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = option.offsetTop + option.offsetHeight - el.clientHeight;
  }, [id, highlight]);

  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label={label}
      onScroll={measure}
      className={cn(
        'absolute bottom-full left-0 z-10 mb-2 max-h-[357px] max-w-full overflow-y-auto rounded-2xl bg-popover p-1 text-body shadow-popover',
        'transition-[opacity,translate] duration-(--at-duration-snap) ease-snap starting:translate-y-1 starting:opacity-0',
        wide ? 'w-[480px]' : 'w-90',
        more && '[mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]',
      )}
    >
      {items.length === 0 ? (
        <p className="px-2.5 py-1.5 text-fg-muted">No matching files</p>
      ) : (
        items.map((item, i) => (
          <button
            key={i}
            id={optionId(id, i)}
            type="button"
            role="option"
            tabIndex={-1}
            title={item.title}
            aria-selected={i === highlight}
            // Keeps the focus (and the caret) in the message box.
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== highlight && onHighlight(i)}
            onClick={item.pick}
            className={cn('flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left outline-none', i === highlight && 'bg-fill-ghost-hover')}
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-fg-secondary">
              <Icon icon={item.icon} size="sm" />
            </span>
            {item.row}
          </button>
        ))
      )}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
