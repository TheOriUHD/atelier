/**
 * Wraps a provider adapter so every request's images fit what that provider takes (providers/images.ts), and so a
 * request the provider still refuses over an image is sent again without the images that could be the cause, instead
 * of leaving the conversation unable to go on.
 */
import type { ImagePart, Message, MessageError, Part } from '@atelier/protocol';
import { fitImageCached, type BlobOverlay, type ImagePolicy } from './images.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent } from './types.ts';

type Decision = { part: ImagePart; note?: string } | { text: string };

const noteText = (what: string) => `[${what}]`;

const imagesIn = (parts: readonly Part[]): ImagePart[] => parts.flatMap((p) => (p.type === 'image' ? [p] : p.type === 'tool_result' ? imagesIn(p.content) : []));

/** What a provider says when it refuses an image: a size, a type that doesn't match, too many, one it can't read. */
export function refusesImage(error: MessageError | undefined): boolean {
  const m = error?.message ?? '';
  return /\bimages?\b/i.test(m) && /(dimension|pixel|too large|too big|exceed|resolution|too many|at most|maximum|limit|does not match|media.?type|could not (process|decode|read)|unable to (process|decode)|invalid|unsupported|corrupt|cannot identify)/i.test(m);
}

/**
 * The request's messages with each image fitted, left out or kept, in place of the originals. `readBlob` reads what a
 * part names; fitted bytes are added to `overlay` and named there. Returns the same array when nothing changed.
 */
export async function fitMessages(
  messages: readonly Message[],
  policy: ImagePolicy,
  readBlob: (sha: string) => Promise<Uint8Array>,
  overlay: BlobOverlay,
  rejected: ReadonlySet<string> = new Set(),
): Promise<readonly Message[]> {
  const all = messages.flatMap((m) => (m.role === 'assistant' ? [] : imagesIn(m.parts)));
  if (all.length === 0) return messages;

  const decisions = new Map<ImagePart, Decision>();
  let kept = all.filter((p) => {
    if (!rejected.has(p.blob)) return true;
    decisions.set(p, { text: noteText('An image is left out: the provider could not take it') });
    return false;
  });
  if (policy.maxCount !== null && kept.length > policy.maxCount) {
    for (const p of kept.slice(0, kept.length - policy.maxCount)) decisions.set(p, { text: noteText(`An earlier image is left out: a request can hold at most ${policy.maxCount} images`) });
    kept = kept.slice(-policy.maxCount);
  }
  // Past a number of images the provider also shrinks the side it takes (Anthropic: 2000 pixels past 20).
  const manySide = policy.many && kept.length > policy.many.above ? policy.many.side : null;
  const side = manySide !== null ? Math.min(manySide, policy.maxSide ?? manySide) : policy.maxSide;

  const sizes = new Map<ImagePart, number>();
  for (const part of kept) {
    const bytes = await readBlob(part.blob);
    const result = fitImageCached(part.blob, bytes, part.mime, side, policy.maxBytes);
    if (!result.ok) {
      decisions.set(part, { text: noteText(`An image ${result.reason}, so it is left out`) });
      continue;
    }
    const { image } = result;
    sizes.set(part, image.bytes.length);
    if (image.changed) {
      decisions.set(part, {
        part: { type: 'image', mime: image.mime, blob: overlay.add(image.bytes) },
        note: noteText(`This image was reduced to ${image.width}×${image.height} pixels to fit what the provider takes`),
      });
    } else if (image.mime !== part.mime) {
      decisions.set(part, { part: { type: 'image', mime: image.mime, blob: part.blob } });
    }
  }
  // The request's own size limit: the newest images stay.
  if (policy.totalBytes !== null) {
    let total = 0;
    for (const part of [...kept].reverse()) {
      const size = sizes.get(part);
      if (size === undefined) continue;
      total += size;
      if (total > policy.totalBytes) decisions.set(part, { text: noteText("An earlier image is left out to keep the request within the provider's size limit") });
    }
  }
  if (decisions.size === 0) return messages;

  const fitParts = <P extends Part>(parts: readonly P[]): Part[] =>
    parts.flatMap((p): Part[] => {
      if (p.type === 'tool_result') return [{ ...p, content: fitParts(p.content) as typeof p.content }];
      if (p.type !== 'image') return [p];
      const d = decisions.get(p);
      if (!d) return [p];
      if ('text' in d) return [{ type: 'text', text: d.text }];
      return d.note ? [d.part, { type: 'text', text: d.note }] : [d.part];
    });
  return messages.map((m) => (m.role === 'assistant' || imagesIn(m.parts).every((p) => !decisions.has(p)) ? m : { ...m, parts: fitParts(m.parts) }));
}

/**
 * Every image in the history (older than the newest message), or every image at all, as a note, for a retry; `changed`
 * is false when there was nothing of that kind to take out.
 */
function stripImages(messages: readonly Message[], history: boolean, rejected: Set<string>): { messages: readonly Message[]; changed: boolean } {
  const last = messages.at(-1);
  let changed = false;
  const strip = (parts: readonly Part[]): Part[] =>
    parts.map((p): Part => {
      if (p.type === 'tool_result') return { ...p, content: strip(p.content) as typeof p.content };
      if (p.type !== 'image') return p;
      changed = true;
      rejected.add(p.blob);
      return { type: 'text', text: noteText('An image is left out: the provider could not take it') };
    });
  const out = messages.map((m) => (m.role === 'assistant' || (history && m === last) || imagesIn(m.parts).length === 0 ? m : { ...m, parts: strip(m.parts) }));
  return { messages: out, changed };
}

export function withImageLimits(
  adapter: ProviderAdapter,
  overlay: BlobOverlay,
  policy: ImagePolicy,
  readBlob: (sha: string) => Promise<Uint8Array>,
): ProviderAdapter {
  /** Images a provider refused although they were within the limits; kept out of later requests too. */
  const rejected = new Set<string>();
  const fit = <R extends { messages: readonly Message[] }>(request: R): Promise<R> =>
    fitMessages(request.messages, policy, readBlob, overlay, rejected).then((messages) => (messages === request.messages ? request : { ...request, messages: [...messages] }));

  const wrapped: ProviderAdapter = {
    type: adapter.type,
    listModels: (signal) => adapter.listModels(signal),
    health: (signal) => adapter.health(signal),
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      let current = await fit(request);
      // A refusal over an image the checks let through: again without the history's images, then without any.
      for (let attempt = 0; ; attempt++) {
        const iterator = adapter.stream(current)[Symbol.asyncIterator]();
        try {
          const first = await iterator.next();
          const hasImages = current.messages.some((m) => m.role !== 'assistant' && imagesIn(m.parts).length > 0);
          if (!first.done && first.value.type === 'finish' && first.value.reason === 'error' && refusesImage(first.value.error) && hasImages && attempt < 2 && !request.signal.aborted) {
            // The history's images first; when it has none the refused one is the newest, and every image goes at once.
            let stripped = stripImages(current.messages, attempt === 0, rejected);
            if (!stripped.changed && attempt === 0) {
              stripped = stripImages(current.messages, false, rejected);
              attempt = 1;
            }
            current = { ...current, messages: [...stripped.messages] };
            continue;
          }
          if (first.done) return;
          yield first.value;
          for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value;
          return;
        } finally {
          // Consumers may stop at finish without asking for the next event that releases the provider.
          await iterator.return?.();
        }
      }
    },
    ...(adapter.countTokens ? { countTokens: async (request: Parameters<NonNullable<ProviderAdapter['countTokens']>>[0]) => adapter.countTokens!(await fit(request)) } : {}),
    ...(adapter.serverLimits ? { serverLimits: (signal?: AbortSignal) => adapter.serverLimits!(signal) } : {}),
  };
  return wrapped;
}

