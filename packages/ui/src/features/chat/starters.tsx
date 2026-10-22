/**
 * Starter chips under the new-chat composer for people with few chats: a category opens a few example prompts,
 * and picking one puts it in the message box to edit or send.
 */
import { useState } from 'react';
import { CodeXml, Coffee, Dices, GraduationCap, PenLine, X, type LucideIcon } from 'lucide-react';
import { Icon, IconButton, cn } from '../../components/ui/index.ts';

interface Category {
  label: string;
  icon: LucideIcon;
  prompts: readonly string[];
}

export const STARTERS: readonly Category[] = [
  {
    label: 'Write',
    icon: PenLine,
    prompts: [
      'Help me write a warm thank-you note to a colleague who covered for me',
      'Turn these rough notes into a clear project update: ',
      'Draft a short speaker bio for a talk about ',
      'Rewrite this paragraph so it reads more easily: ',
    ],
  },
  {
    label: 'Learn',
    icon: GraduationCap,
    prompts: [
      'Explain how vaccines teach the immune system, for someone curious but not a biologist',
      'What’s the difference between weather and climate?',
      'Give me a ten-minute crash course on compound interest',
      'Quiz me on the basics of the French Revolution',
    ],
  },
  {
    label: 'Code',
    icon: CodeXml,
    prompts: [
      'Explain what this regular expression matches: ',
      'Write a Python script that renames photos by the date they were taken',
      'Help me understand this error message: ',
      'How should I structure a small REST API?',
    ],
  },
  {
    label: 'Life stuff',
    icon: Coffee,
    prompts: [
      'Plan a relaxed weekend in a city I’ve never been to',
      'Suggest a week of simple dinners made mostly from pantry staples',
      'Help me prepare for a difficult conversation with my landlord',
      'Make me a four-week running plan for a beginner',
    ],
  },
];

/** "Surprise me" draws from here. */
const SURPRISES = [
  'Invent a board game played with a deck of cards and a teaspoon',
  'Write a haiku from the point of view of a houseplant',
  'If octopuses built cities, what would their architecture look like?',
  'Tell the history of the sandwich as a dramatic movie trailer',
  'Design a holiday that celebrates something small and ordinary',
  'What would a weather report on Mars sound like today?',
  'Describe a color to someone who has never seen it',
  'Write a short, polite complaint letter from a cat to its owner',
];

/** `count` prompts from `list` in random order. */
export function pickRandom(list: readonly string[], count: number, random = Math.random): string[] {
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

export function Starters({ onPick, className }: { onPick(prompt: string): void; className?: string }) {
  const [open, setOpen] = useState<Category | null>(null);
  const chip =
    'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-body text-fg-secondary inset-ring inset-ring-line outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg';

  if (open)
    return (
      <section
        aria-label={open.label}
        className={cn('overflow-hidden rounded-2xl bg-raised shadow-composer', className)}
      >
        <div className="flex h-10 items-center gap-2 pr-1.5 pl-4 text-body text-fg-secondary">
          <Icon icon={open.icon} />
          <h2 className="flex-1">{open.label}</h2>
          <IconButton icon={X} label="Close" size="sm" onClick={() => setOpen(null)} />
        </div>
        <ul>
          {open.prompts.map((prompt) => (
            <li key={prompt} className="border-t border-line-subtle">
              <button
                type="button"
                onClick={() => {
                  onPick(prompt);
                  setOpen(null);
                }}
                className="flex min-h-11 w-full items-center px-4 py-2 text-left text-body text-fg outline-none focus-ring hover:bg-fill-ghost-hover"
              >
                {prompt.trimEnd()}
              </button>
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <div role="group" aria-label="Ideas to start with" className={cn('flex flex-wrap justify-center gap-2', className)}>
      {STARTERS.map((c) => (
        <button key={c.label} type="button" onClick={() => setOpen(c)} className={chip}>
          <Icon icon={c.icon} />
          {c.label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setOpen({ label: 'Surprise me', icon: Dices, prompts: pickRandom(SURPRISES, 4) })}
        className={chip}
      >
        <Icon icon={Dices} />
        Surprise me
      </button>
    </div>
  );
}
