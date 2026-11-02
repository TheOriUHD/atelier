/**
 * Images on a ChatGPT Plan, through the Responses request Codex's backend takes, using the existing sign-in and
 * `codexFetch`. OpenAI publishes nothing for this backend, so this is unproven until someone runs it with a real
 * account: every refusal says plainly that this route was turned down.
 *
 * The events and the tool are OpenAI's public Responses API:
 * https://developers.openai.com/api/docs/guides/image-generation (read on 2026-11-02).
 * Codex's own source (openai/codex, codex-rs/protocol/src/models.rs) confirms the `image_generation_call` item. Its own
 * image tool has moved to a client-side call of `images/generations` on the same backend (codex-rs/codex-api), which
 * `codexFetch` doesn't reach today.
 */
import { CHATGPT_BASE_URL } from '../../providers/chatgpt-auth.ts';
import { codexFetch } from '../../providers/chatgpt.ts';
import { httpError, redact, requestJson } from '../../providers/http.ts';
import { parseSSE } from '../../providers/sse.ts';
import type { ChatGptPort, ProviderFetch } from '../../providers/types.ts';
import { arr, dataUrl, isRecord, num, rec, str } from '../../providers/util.ts';
import { lookUp, OPENAI_MODELS } from '../catalog.ts';
import { guardImages } from '../guard.ts';
import type { ImageAdapter, ImageAdapterDeps, ImageEvent, ImageInstance, ImageRequest } from '../types.ts';
import { failure, listedModel, noImage, soundsRefused, refusal, streamedError } from './hosted.ts';

/** Named so it matches no price: images on a plan are paid for by the plan. */
const MODEL_ID = 'chatgpt-plan-image';
/** The Responses request needs a text model to call the tool; this one when the account's list can't be read. */
const FALLBACK_TEXT_MODEL = 'gpt-5.5';
/** Codex sends at most this many inputs. */
const MAX_INPUTS = 5;
const PARTIAL_IMAGES = 2;
const INSTRUCTIONS = 'Make the image the person describes with the image_generation tool, then stop. Write no text.';

const capabilities = { ...lookUp(OPENAI_MODELS, 'gpt-image-2'), family: 'chatgpt-plan', maxCount: 1, mask: false, maxReferences: MAX_INPUTS };

function requestBody(request: ImageRequest, textModel: string): Record<string, unknown> {
  const images = request.references.map((image) => ({ type: 'input_image', image_url: dataUrl(image.mime, image.bytes) }));
  return {
    model: textModel,
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: [{ type: 'input_text', text: request.prompt }, ...images] }],
    tools: [
      {
        type: 'image_generation',
        output_format: 'png',
        partial_images: PARTIAL_IMAGES,
        quality: request.quality === 'draft' ? 'low' : request.quality === 'high' ? 'high' : 'medium',
        ...(request.width && request.height ? { size: `${request.width}x${request.height}` } : {}),
        ...(request.transparent ? { background: 'transparent' } : {}),
      },
    ],
    tool_choice: { type: 'image_generation' },
    stream: true,
    store: false,
  };
}

/** The backend said no to the request itself, which on this undocumented route may mean the route is closed. */
async function turnedDown(instance: ImageInstance, res: Response): Promise<Extract<ImageEvent, { type: 'finish' }>> {
  const raw = await res.clone().text().catch(() => '');
  const error = await httpError(res, instance);
  if (res.status === 429 || res.status >= 500 || res.status === 401) return failure(error);
  if (soundsRefused(raw) && !/image_generation|tool/i.test(raw)) return refusal(instance, error.message);
  return failure({ code: 'provider_error', message: `The ChatGPT Plan backend didn't accept this image request (${res.status}), so images may not be available on this plan through Atelier. It said: ${redact(error.message, instance)}`, retryable: false });
}

async function* run(instance: ImageInstance, fetch: ProviderFetch, request: ImageRequest, textModel: string): AsyncGenerator<ImageEvent> {
  const res = await fetch(`${CHATGPT_BASE_URL}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody(request, textModel)), signal: request.signal });
  if (!res.ok) {
    yield await turnedDown(instance, res);
    return;
  }
  if (!res.body) throw new Error(`${instance.name} sent an empty answer.`);
  let images = 0;
  let text = '';
  for await (const event of parseSSE(res.body, request.signal)) {
    const data = rec(JSON.parse(event.data));
    const type = str(data.type) ?? event.event;
    if (type === 'response.image_generation_call.partial_image') {
      const preview = str(data.partial_image_b64);
      if (preview) yield { type: 'preview', mime: 'image/png', data: preview };
    } else if (type === 'response.image_generation_call.generating' || type === 'response.image_generation_call.in_progress') {
      yield { type: 'progress' };
    } else if (type === 'response.output_text.delta') {
      text += str(data.delta) ?? '';
    } else if (type === 'response.output_item.done') {
      const item = rec(data.item);
      const result = str(item.result);
      if (str(item.type) !== 'image_generation_call') continue;
      if (result) {
        images++;
        const revisedPrompt = str(item.revised_prompt);
        yield { type: 'image', bytes: Buffer.from(result, 'base64'), ...(revisedPrompt ? { revisedPrompt } : {}) };
      }
    } else if (type === 'response.failed' || type === 'error') {
      yield streamedError(instance, type === 'error' ? data : rec(rec(data.response).error));
      return;
    } else if (type === 'response.incomplete') {
      yield noImage(instance, str(rec(rec(data.response).incomplete_details).reason), true);
      return;
    }
  }
  if (images > 0) yield { type: 'finish', reason: 'done' };
  else if (soundsRefused(text)) yield refusal(instance, text);
  else yield noImage(instance, text || undefined);
}

export function createResponsesImage(instance: ImageInstance, deps: ImageAdapterDeps): ImageAdapter {
  const auth: ChatGptPort | undefined = deps.chatgpt;
  if (!auth) {
    const unavailable = 'This backend has no way to sign in with ChatGPT.';
    return {
      type: 'responses-image',
      listModels: async () => [],
      health: async () => ({ ok: false, latencyMs: null, warnings: [], error: unavailable }),
      async *generate() {
        yield { type: 'finish', reason: 'error', error: { code: 'provider_auth', message: unavailable, retryable: false } };
      },
    };
  }
  const fetch = codexFetch(deps.fetch, auth);
  let textModel: Promise<string> | undefined;
  /** Any model the account lists can call the tool, so the one it lists first. */
  const pickTextModel = async () => {
    try {
      const json = await requestJson({ fetch }, { ...instance, apiKey: 'chatgpt-session' }, `${CHATGPT_BASE_URL}/models`, { headers: {} });
      const listed = arr(rec(json).models).filter(isRecord).filter((m) => str(m.visibility) === 'list').sort((a, b) => (num(a.priority) ?? 1e6) - (num(b.priority) ?? 1e6));
      return str(listed[0]?.slug) ?? FALLBACK_TEXT_MODEL;
    } catch {
      return FALLBACK_TEXT_MODEL;
    }
  };
  return {
    type: 'responses-image',
    listModels: () => Promise.resolve([listedModel(instance, MODEL_ID, capabilities, 'catalog', { displayName: 'ChatGPT Images' })]),
    async health() {
      const started = Date.now();
      try {
        await auth.credentials();
        return { ok: true, latencyMs: Date.now() - started, warnings: [] };
      } catch (e) {
        return { ok: false, latencyMs: null, warnings: [], error: e instanceof Error ? e.message : 'Not signed in.' };
      }
    },
    generate(request) {
      return guardImages(request, instance, async function* () {
        textModel ??= pickTextModel();
        yield* run(instance, fetch, request, await textModel);
      });
    },
  };
}
