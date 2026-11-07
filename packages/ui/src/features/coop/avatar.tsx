/** People in a co-op session (design/components.md › Co-op): an avatar with its online dot, and a small stack of them. */
import type { Participant } from '@atelier/protocol';
import { cn } from '../../components/ui/index.ts';
import { blobUrl } from '../../lib/platform.ts';

/** An account's avatar is a blob; a guest from another computer sends a small image as a data URL. */
export function avatarSrc(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  if (avatar.startsWith('data:')) return /^data:image\/(png|jpeg|gif|webp);base64,/.test(avatar) ? avatar : null;
  return /^[0-9a-f]{64}$/.test(avatar) ? blobUrl(avatar) : null;
}

const SIZE = { xs: 'size-4 text-[9px]', sm: 'size-5 text-[10px]', md: 'size-6 text-caption' } as const;
const DOT = { xs: 'size-1.5', sm: 'size-2', md: 'size-2' } as const;

/** A round avatar (the first letter of the name without one); `online` adds a green dot, false a hollow one. */
export function Avatar({ name, avatar, size = 'sm', online, className }: { name: string; avatar: string | null | undefined; size?: keyof typeof SIZE; online?: boolean; className?: string }) {
  const src = avatarSrc(avatar);
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      {src ? (
        <img src={src} alt="" className={cn('rounded-full object-cover', SIZE[size])} />
      ) : (
        <span aria-hidden className={cn('flex items-center justify-center rounded-full bg-fill-primary font-medium text-on-primary', SIZE[size])}>
          {name.trim().slice(0, 1).toUpperCase() || '?'}
        </span>
      )}
      {online !== undefined && (
        <span
          aria-hidden
          className={cn('absolute -right-px -bottom-px rounded-full ring-2 ring-bg', DOT[size], online ? 'bg-success' : 'bg-bg inset-ring-[1.5px] inset-ring-fg-muted')}
        />
      )}
    </span>
  );
}

/** The header's stack: up to four overlapping avatars with online dots. */
export function AvatarStack({ people }: { people: readonly Participant[] }) {
  return (
    <span aria-hidden className="flex items-center">
      {people.slice(0, 4).map((p, i) => (
        <Avatar key={p.id} name={p.name} avatar={p.avatar} online={p.online} className={cn('rounded-full ring-2 ring-bg', i > 0 && '-ml-1.5', !p.online && 'opacity-60')} />
      ))}
    </span>
  );
}
