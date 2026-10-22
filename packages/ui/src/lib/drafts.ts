/**
 * Unsent messages, kept per message box in this browser or window so leaving a conversation (or reloading) doesn't lose
 * what was typed. Each box names its draft (`draftKey`); drafts are kept apart per server and signed-in person, so
 * another account on this device doesn't see them. Uploaded attachment references are kept alongside the text.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FileRef } from '@atelier/protocol';
import { keys } from './queries.ts';
import { desktop } from './platform.ts';
import { rpc } from './rpc.ts';

const KEY = 'atelier.drafts';

/** Drafts left alone this long are dropped (their conversations were likely deleted or forgotten). */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many drafts are kept, the most recently typed in. */
export const MAX_DRAFTS = 50;

/** The draft names: each conversation its own, the new chat and the new Cowork task one together, Code's new session its own. */
export const draftKeys = {
  session: (id: string) => `session:${id}`,
  newChat: 'new',
  newCode: 'new:code',
  project: (id: string) => `project:${id}`,
};

export interface DraftAttachment {
  key: string;
  name: string;
  mime: string;
  size: number;
  file: FileRef;
  lines?: number;
}

interface Draft {
  text: string;
  attachments?: DraftAttachment[];
  at: number;
}
type Drafts = Record<string, Draft>;

let lastRaw: string | null = null;
let lastDrafts: Drafts = {};
const listeners = new Set<() => void>();

function read(storage = safeStorage()): Drafts {
  let raw: string | null;
  try {
    raw = storage?.getItem(KEY) ?? null;
  } catch {
    return lastDrafts;
  }
  if (raw === lastRaw) return lastDrafts;
  lastRaw = raw;
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    lastDrafts = parsed && typeof parsed === 'object' ? (parsed as Drafts) : {};
  } catch {
    lastDrafts = {};
  }
  return lastDrafts;
}

/** `drafts` without the ones older than `DRAFT_MAX_AGE_MS`, and only the `MAX_DRAFTS` most recent. */
export function pruneDrafts(drafts: Drafts, now: number): Drafts {
  const kept = Object.entries(drafts)
    .filter(([, d]) => typeof d?.text === 'string' && (d.text !== '' || !!d.attachments?.length) && typeof d.at === 'number' && now - d.at < DRAFT_MAX_AGE_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_DRAFTS);
  return Object.fromEntries(kept);
}

export function draftText(key: string): string {
  return read()[key]?.text ?? '';
}

const NO_ATTACHMENTS: DraftAttachment[] = [];
export function draftAttachments(key: string): DraftAttachment[] {
  const draft = read()[key];
  return draft && Date.now() - draft.at < DRAFT_MAX_AGE_MS ? (draft.attachments ?? NO_ATTACHMENTS) : NO_ATTACHMENTS;
}

/** Updates just the text; attachment-only drafts remain until their files are removed. */
export function saveDraft(key: string, text: string, now = Date.now()): void {
  updateDraft(key, { text }, now);
}

export function saveDraftAttachments(key: string, attachments: DraftAttachment[], now = Date.now()): void {
  // Deliberately whitelist metadata: never keep previews, local Files, or base64 in browser storage.
  updateDraft(key, { attachments: attachments.map(({ key, name, mime, size, file, lines }) => ({ key, name, mime, size, file, ...(lines === undefined ? {} : { lines }) })) }, now);
}

function updateDraft(key: string, patch: Partial<Draft>, now: number): void {
  const storage = safeStorage();
  const next = { ...read(storage) };
  next[key] = { text: '', ...next[key], ...patch, at: now };
  lastDrafts = pruneDrafts(next, now);
  try {
    lastRaw = JSON.stringify(lastDrafts);
    storage?.setItem(KEY, lastRaw);
  } catch {
    // Storage blocked or full: the draft still lasts while this page is open.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whose drafts these are: the server (desktop app: this computer or the server it connects to) and the signed-in person. */
export function useDraftScope(enabled: boolean): string | null {
  const { data: account } = useQuery({ queryKey: keys.account, queryFn: () => rpc().call('account.get', {}), enabled });
  const { data: connection } = useQuery({ queryKey: ['connection'], queryFn: () => desktop!.connection.get(), enabled: enabled && !!desktop });
  if (!account) return null;
  if (!desktop) return account.id;
  if (!connection) return null;
  return `${connection.mode === 'server' ? (connection.serverUrl ?? '') : 'local'} ${account.id}`;
}

/** The draft named `key`, kept as it changes; without a key it is only the box's own state. */
export function useDraft(key: string | undefined): readonly [string, (text: string) => void] {
  const scope = useDraftScope(!!key);
  const stored = key && scope ? `${scope}|${key}` : null;
  const [local, setLocal] = useState('');
  const unkept = useRef('');
  const kept = useSyncExternalStore(subscribe, () => (stored ? draftText(stored) : ''));
  // Typed before the account was known: kept once it is, unless a draft was already there.
  useEffect(() => {
    if (!stored || !unkept.current) return;
    if (!draftText(stored)) saveDraft(stored, unkept.current);
    unkept.current = '';
  }, [stored]);
  const set = useCallback(
    (text: string) => {
      if (stored) return saveDraft(stored, text);
      if (key) unkept.current = text;
      setLocal(text);
    },
    [stored, key],
  );
  return [stored ? kept : local, set];
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
