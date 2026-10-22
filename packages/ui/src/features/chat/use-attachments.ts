import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { QUOTE_MAX_CHARS, QUOTE_MAX_COUNT, type FileRef, type Part } from '@atelier/protocol';
import { blobUrl } from '../../lib/platform.ts';
import { draftAttachments, saveDraftAttachments, useDraftScope, type DraftAttachment } from '../../lib/drafts.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Browsers leave `File.type` empty for most source files; these are sent as text. */
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|lua|r|m|ini|cfg|conf|env|log|tex|svg)$/i;

export interface Attachment {
  key: string;
  name: string;
  mime: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  file?: FileRef;
  error?: string;
  /** Object URL for image thumbnails. */
  preview?: string;
  /** Line count for text files. */
  lines?: number;
}

export function mimeFor(file: File): string {
  if (file.type) return file.type;
  if (/\.pdf$/i.test(file.name)) return 'application/pdf';
  if (/\.(md|markdown)$/i.test(file.name)) return 'text/markdown';
  return TEXT_EXTENSIONS.test(file.name) ? 'text/plain' : 'application/octet-stream';
}

export const isImage = (mime: string) => IMAGE_MIMES.has(mime);
export const isText = (mime: string) => mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml';

export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

interface AttachmentStore {
  draftKey?: string;
  items: Attachment[];
  listeners: Set<() => void>;
  stored: string | null;
  target?: AttachmentStore;
}
const stores = new Map<string, AttachmentStore>();
const createStore = (stored: string | null, draftKey?: string): AttachmentStore => ({
  draftKey,
  stored,
  listeners: new Set(),
  items: stored ? draftAttachments(stored).map((a) => ({ ...a, status: 'ready', ...(isImage(a.mime) ? { preview: blobUrl(a.file.blob) } : {}) })) : [],
});
function releaseStore(store: AttachmentStore) {
  if (store.listeners.size || store.items.some((a) => a.status === 'uploading')) return;
  if (store.stored && stores.get(store.stored) === store) stores.delete(store.stored);
  store.items = store.items.map((a) => {
    if (!a.preview?.startsWith('blob:')) return a;
    URL.revokeObjectURL(a.preview);
    return { ...a, preview: a.file && isImage(a.mime) ? blobUrl(a.file.blob) : undefined };
  });
}
function updateItems(store: AttachmentStore, update: (items: Attachment[]) => Attachment[]) {
  if (store.target) return updateItems(store.target, update);
  const next = update(store.items);
  if (next === store.items) return;
  for (const a of store.items) if (a.preview?.startsWith('blob:') && !next.some((b) => b.preview === a.preview)) URL.revokeObjectURL(a.preview);
  store.items = next;
  if (store.stored) saveDraftAttachments(store.stored, next.flatMap((a): DraftAttachment[] => a.status === 'ready' && a.file ? [{ key: a.key, name: a.name, mime: a.mime, size: a.size, file: a.file, ...(a.lines === undefined ? {} : { lines: a.lines }) }] : []));
  for (const listener of store.listeners) listener();
  releaseStore(store);
}

function migrateStore(local: AttachmentStore, store: AttachmentStore, stored: string) {
  if (!local.items.length || local.stored) return;
  local.stored = stored;
  updateItems(store, (items) => [...items, ...local.items]);
  local.items = [];
  local.target = store;
}

/** Files attached to the composer. Upload completions belong to the original scoped draft, not the current page. */
export function useAttachments(draftKey?: string) {
  const scope = useDraftScope(!!draftKey);
  const stored = draftKey && scope ? `${scope}|${draftKey}` : null;
  const local = useMemo(() => createStore(null, draftKey), [draftKey]);
  const store = useMemo(() => {
    if (!stored) return local;
    let found = stores.get(stored);
    if (!found) {
      found = createStore(stored);
      stores.set(stored, found);
    }
    return found;
  }, [stored, local]);
  // An attachment selected before account discovery stays with that original box.
  useEffect(() => {
    if (stored) migrateStore(local, store, stored);
  }, [stored, store, local]);
  const subscribe = useCallback((listener: () => void) => {
    if (store.stored) stores.set(store.stored, store);
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); releaseStore(store); };
  }, [store]);
  const items = useSyncExternalStore(subscribe, () => store.items);
  const setItems = useCallback((update: (items: Attachment[]) => Attachment[]) => updateItems(store, update), [store]);
  /** Passages of earlier messages the next message replies to (the "Reply" of a text selection). */
  const [quotes, setQuotes] = useState<string[]>([]);
  const patch = useCallback((key: string, next: Partial<Attachment>) => setItems((list) => list.some((a) => a.key === key) ? list.map((a) => (a.key === key ? { ...a, ...next } : a)) : list), [setItems]);

  const add = useCallback(async (files: File[]) => {
    const uploader = rpc();
    await Promise.all(files.map(async (file) => {
      const key = crypto.randomUUID();
      const mime = mimeFor(file);
      const preview = isImage(mime) ? URL.createObjectURL(file) : undefined;
      const base: Attachment = { key, name: file.name || 'Pasted file', mime, size: file.size, status: 'uploading', ...(preview ? { preview } : {}) };
      if (file.size > MAX_UPLOAD_BYTES) {
        setItems((list) => [...list, { ...base, status: 'error', error: 'Larger than 32 MB' }]);
        return;
      }
      setItems((list) => [...list, base]);
      if (isText(mime) && file.size < 2_000_000) {
        void file.text().then((t) => patch(key, { lines: t.split('\n').length }));
      }
      try {
        const ref = await uploader.call('files.upload', { name: base.name, mime, dataBase64: await readBase64(file) });
        patch(key, { status: 'ready', file: ref });
      } catch (error) {
        patch(key, { status: 'error', error: describeError(error).message });
      }
    }));
  }, [setItems, patch]);

  const remove = useCallback((key: string) => {
    setItems((list) => list.filter((a) => a.key !== key));
  }, [setItems]);

  const addQuote = useCallback((text: string) => {
    const quoted = text.trim().slice(0, QUOTE_MAX_CHARS);
    if (!quoted) return;
    setQuotes((list) => (list.includes(quoted) || list.length >= QUOTE_MAX_COUNT ? list : [...list, quoted]));
  }, []);

  const removeQuote = useCallback((index: number) => setQuotes((list) => list.filter((_, i) => i !== index)), []);

  const clear = useCallback(() => {
    setItems(() => []);
    setQuotes([]);
  }, [setItems]);

  /** Puts files back that were already uploaded (a waiting message taken back): no upload, ready to send again. */
  const restore = useCallback((parts: Part[]) => {
    const quoted = parts.flatMap((p) => (p.type === 'context' && p.notice?.kind === 'quote' ? [p.notice.text] : []));
    if (quoted.length > 0) setQuotes((list) => [...list, ...quoted.filter((q) => !list.includes(q))].slice(0, QUOTE_MAX_COUNT));
    const restored = parts.flatMap((p): Attachment[] => {
      if (p.type !== 'image' && p.type !== 'document') return [];
      // Message parts keep only the stored file's address: the thumbnail is read from there, and so is the size.
      const name = p.type === 'document' ? p.name : `Image.${p.mime.split('/')[1] ?? 'png'}`;
      const file: FileRef = { id: '', name, mime: p.mime, size: 0, blob: p.blob, kind: 'upload', tokens: null, createdAt: 0 };
      return [{ key: crypto.randomUUID(), name, mime: p.mime, size: 0, status: 'ready', file, ...(p.type === 'image' ? { preview: blobUrl(p.blob) } : {}) }];
    });
    setItems((list) => [...list, ...restored]);
    for (const a of restored) {
      void fetch(blobUrl(a.file!.blob))
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => b && patch(a.key, { size: b.size }))
        .catch(() => {});
    }
  }, [setItems, patch]);

  return {
    items,
    quotes,
    addQuote,
    removeQuote,
    add,
    remove,
    clear,
    restore,
    uploading: items.some((a) => a.status === 'uploading'),
    /** Message parts: the quoted passages, then the uploaded files (failed uploads are left out). */
    parts: (): Part[] => [
      ...quotes.map((text): Part => ({ type: 'context', text: '', notice: { kind: 'quote', text } })),
      ...items.flatMap((a): Part[] => {
        if (a.status !== 'ready' || !a.file) return [];
        return isImage(a.mime)
          ? [{ type: 'image', mime: a.mime, blob: a.file.blob }]
          : [{ type: 'document', mime: a.mime, blob: a.file.blob, name: a.name }];
      }),
    ],
  };
}

export type Attachments = ReturnType<typeof useAttachments>;
