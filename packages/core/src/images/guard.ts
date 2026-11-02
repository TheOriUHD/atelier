/** Runs an adapter's events so the service always sees exactly one `finish`, whatever goes wrong. */
import { exceptionError, ProviderHttpError } from '../providers/http.ts';
import type { ImageEvent, ImageInstance, ImageRequest } from './types.ts';

export async function* guardImages(request: ImageRequest, instance: ImageInstance, run: () => AsyncGenerator<ImageEvent>): AsyncGenerator<ImageEvent> {
  const timedOut = () => request.signal.aborted && request.signal.reason instanceof Error && request.signal.reason.name === 'TimeoutError';
  try {
    for await (const event of run()) {
      yield event;
      if (event.type === 'finish') return;
    }
  } catch (err) {
    if (request.signal.aborted && !timedOut()) yield { type: 'finish', reason: 'aborted' };
    else if (err instanceof ProviderHttpError) yield { type: 'finish', reason: 'error', error: err.error };
    else yield { type: 'finish', reason: 'error', error: exceptionError(timedOut() ? request.signal.reason : err, instance) };
    return;
  }
  if (request.signal.aborted && !timedOut()) yield { type: 'finish', reason: 'aborted' };
  else yield { type: 'finish', reason: 'done' };
}

/** A provider said no to the prompt itself: the model hears that it is final. */
export const refusedError = (name: string, detail?: string) => ({ code: 'provider_refused' as const, message: detail ? `${name} refused this: ${detail}` : `${name} refused this.`, retryable: false });
