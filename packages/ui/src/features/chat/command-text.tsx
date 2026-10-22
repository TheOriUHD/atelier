import type { ReactNode } from 'react';

/** The `/command` a message or the box starts with (not a path: no second slash), or null. */
export function leadingCommand(text: string): { command: string; rest: string } | null {
  const match = /^(\/[A-Za-z][\w:.-]*)(?=\s|$)/.exec(text);
  return match ? { command: match[1]!, rest: text.slice(match[1]!.length) } : null;
}

/** Message text with the command it starts with in the link blue, as commands are everywhere in the app. */
export function CommandText({ text }: { text: string }): ReactNode {
  const lead = leadingCommand(text);
  if (!lead) return text;
  return (
    <>
      <span className="text-interactive-text">{lead.command}</span>
      {lead.rest}
    </>
  );
}
