import { randomUUID } from 'node:crypto';
import type { Message } from '@atelier/protocol';
import { fallbackModel, parsePickerModels, pickerModelsToListed, selectionFor, type PickerModel } from './chatgpt-chat-models.ts';
import type { AdapterDeps, ChatRequest, ProviderAdapter, ProviderInstance, StreamEvent } from './types.ts';
import { documentAsText, toBase64 } from './util.ts';

export interface ChatGptChatPort {
  request(operation: 'status' | 'open' | 'hide' | 'disconnect' | 'models' | 'start' | 'poll' | 'stop', value?: string): Promise<string>;
}

interface Rendered {
  role: string;
  text: string;
}

/** The conversation as ChatGPT's page holds it after a complete reply: what was sent, and the reply as one more message. */
interface Held {
  token: string;
  system: string;
  messages: Rendered[];
}

/**
 * ChatGPT's page renders Markdown, and a tool call written as plain text is not safe in it (`__init__.py` turns bold,
 * a glob or `a*b*c` turns into emphasis, an address into a link). A fenced code block is shown as written, so the
 * calls are asked for in one (`TOOL_NOTE`) and the fence is taken off again here, for the parser that reads the call.
 */
export const TOOL_NOTE = [
  '# Writing a tool call in this chat',
  'Write each tool call inside a fenced code block, so the chat window shows it exactly as written:',
  '```\n<tool_call>{"name": "tool_name", "arguments": {"param": "value"}}</tool_call>\n```',
  'Put nothing after the closing fence of a call.',
].join('\n');

/**
 * ChatGPT's page gives the model tools of its own (a Python sandbox, web search, canvas), and left to itself it runs a
 * command or fetches a page there, reports a result that never touched the project, and never calls the tool the
 * program offered. This goes at the top of the first message, and `TOOL_REMINDER` ends every message that follows.
 */
export const TOOL_FRAMING = [
  '# How this chat works',
  'A program runs this chat, not a person. You are its assistant, and the program runs tools for you. In this chat you have no tools of your own: no Python or other code execution, no web browsing or search, no file access, no canvas. Anything you ran yourself would not touch the project or the machine the program works on, so never run code or fetch anything yourself, and never claim to have.',
  'To read a file, run a command, fetch a page or change anything, write a tool call in the format given below and stop. The program runs it and answers in its next message.',
].join('\n');

/** What is said back when ChatGPT answered without a tool call: from its own sandbox, or refusing and asking the person to do it. */
export const TOOL_CORRECTION = 'That is not how this chat works. You cannot run anything yourself, and a sandbox of yours is not the user’s computer, so nothing it shows is real here. You also must not ask the user to paste or run anything. For anything that needs a file, a command, the web or a change, write a tool call in the format given at the start of this chat (inside a fenced block): the program carries it out on the user’s computer and sends you the result. Do that now, and write nothing else.';

/**
 * Whether a reply without a tool call is ChatGPT answering from its own sandbox or declining to use the tools it was
 * given, which is what the corrections are for. Measured on chatgpt.com: asked to read a file or run a command, it says
 * it cannot ("I can’t run npm test in your repository from this chat", "please paste its contents") or reports what it
 * found "in the current directory" of its own container.
 */
export function needsToolCall(text: string): boolean {
  const head = text.replace(/[’‘]/g, "'").slice(0, 600);
  return (
    /\b(?:can(?:'t|not)|could(?:n't| not)|unable to|(?:do(?:n't| not)|does(?:n't| not)) have (?:the )?(?:ability|access|tool)s?)\b[^.\n]{0,70}\b(?:access|run|execute|read|open|check|fetch|browse|reach|view|list|search|write|create|modify|find)\b/i.test(head) ||
    /\b(?:please|you(?:'ll| will)? (?:need|have) to) (?:paste|provide|upload|share|run|copy)\b/i.test(head) ||
    /\b(?:in|under) the (?:current|working)(?: working)? director(?:y|ies)\b|\/mnt\/data|\/home\/oai|\bcurrent working directory is `?\//i.test(head)
  );
}

/** How often such a reply is sent back before it counts as the answer (or, from the sandbox, as a failure). */
const MAX_CORRECTIONS = 2;

export const TOOL_REMINDER = '(The program runs tools for you; you have none of your own. To act, write a tool call; never run code or browse yourself.)';

export function unfenceToolCalls(text: string): string {
  const closed = text.replace(/(^|\n)[ \t]*```[\w+-]*[ \t]*\n\s*(<tool_call>[\s\S]*?<\/tool_call>)\s*\n[ \t]*```[ \t]*(?=\n|$)/g, '$1$2');
  // A fence still open at the end of a reply being written goes too, so it does not flash before the call is complete.
  return closed.replace(/(^|\n)[ \t]*```[\w+-]*[ \t]*\n(\s*<tool_call>(?:(?!<\/tool_call>)[\s\S])*)$/, '$1$2');
}

/** A file the message carries (an image or a PDF), named as the message says it. */
interface FileRef {
  name: string;
  mime: string;
  blob: string;
}

/** Most files ChatGPT takes in one message, and the largest image or file it takes (20 MB for an image). */
const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };

/**
 * The messages as ChatGPT's page gets them: text, with an attached image or PDF named in the text where it was and
 * sent along as a file, and a text document put into the text itself.
 */
async function renderMessages(messages: readonly Message[], deps: AdapterDeps): Promise<{ rendered: Rendered[]; files: FileRef[][] }> {
  const rendered: Rendered[] = [];
  const files: FileRef[][] = [];
  let images = 0;
  for (const message of messages) {
    const own: FileRef[] = [];
    const pieces: string[] = [];
    for (const part of message.parts) {
      if (part.type === 'text') pieces.push(part.text);
      else if (part.type === 'tool_result') pieces.push(JSON.stringify(part.content));
      else if (part.type === 'image') {
        const name = `image-${++images}.${EXTENSIONS[part.mime] ?? 'png'}`;
        own.push({ name, mime: part.mime, blob: part.blob });
        pieces.push(`[attached image: ${name}]`);
      } else if (part.type === 'document') {
        if (part.mime === 'application/pdf') {
          const name = part.name.replace(/[\\/]/g, '_');
          own.push({ name, mime: part.mime, blob: part.blob });
          pieces.push(`[attached file: ${name}]`);
        } else pieces.push(documentAsText(part, await deps.readBlob(part.blob)));
      }
    }
    rendered.push({ role: message.role, text: pieces.join('\n') });
    files.push(own);
  }
  return { rendered, files };
}

const show = (messages: readonly Rendered[]): string => messages.map((message) => `[${message.role}]\n${message.text}`).join('\n\n');

/**
 * Whether `next` is the conversation `held` with messages added at the end, so only those need sending. ChatGPT keeps
 * its own replies, so an assistant message counts by its place, not by its text (Atelier may have reshaped it: the
 * tool calls written out, the whitespace); everything the person or a tool said must match exactly.
 */
export function continuesConversation(held: Held | null, system: string, next: readonly Rendered[]): held is Held {
  return !!held && held.system === system && next.length > held.messages.length && held.messages.every((message, index) => next[index]!.role === message.role && (message.role === 'assistant' || next[index]!.text === message.text));
}

export function createChatGptChatAdapter(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  const bridge = deps.chatgptChat;
  let held: Held | null = null;
  /** The account's models with their stops, as the picker lists them (the desktop keeps them for a while). */
  let picker: PickerModel[] = [];
  const scan = async (): Promise<PickerModel[]> => {
    if (!bridge) return [];
    try {
      const found = parsePickerModels(await bridge.request('models'));
      if (found.length > 0) picker = found;
    } catch {
      // The page is not ready (not signed in, not loaded): the last list stands.
    }
    return picker;
  };
  return {
    type: instance.type,
    async health() {
      if (!bridge) return { ok: false, latencyMs: null, warnings: [], error: 'ChatGPT Chat requires the desktop app.' };
      const state = JSON.parse(await bridge.request('status')) as { signedIn: boolean };
      return { ok: state.signedIn, latencyMs: null, warnings: ['Experimental browser connection. ChatGPT limits apply.'], ...(!state.signedIn ? { error: 'Open the ChatGPT session to sign in.' } : {}) };
    },
    async listModels() {
      const listed = pickerModelsToListed(instance, await scan());
      return listed.length > 0 ? listed : [fallbackModel(instance)];
    },
    async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
      if (!bridge) {
        yield { type: 'finish', reason: 'error', error: { code: 'provider_auth', message: 'ChatGPT Chat requires the desktop app.', retryable: false } };
        return;
      }
      if (request.signal.aborted) { yield { type: 'finish', reason: 'aborted' }; return; }
      let id = randomUUID();
      let attempted = false;
      let stopping: Promise<unknown> | undefined;
      const stop = () => stopping ??= bridge.request('stop', id).catch(() => {});
      const onAbort = () => { void stop(); };
      let terminal: StreamEvent = { type: 'finish', reason: 'end' };
      try {
        const { rendered, files } = await renderMessages(request.messages, deps);
        const given = request.system.map((block) => block.text).join('\n\n');
        // Tools reach this provider as text instructions (providers/prompted-tools.ts).
        const withTools = given.includes('<tool_call>');
        const system = withTools ? `${TOOL_FRAMING}\n\n${given}\n\n${TOOL_NOTE}` : given;
        // Every message that goes out ends with a reminder, so a long conversation does not forget the framing.
        const remind = (text: string) => (withTools ? `${text}\n\n${TOOL_REMINDER}` : text);
        const prompt = remind([system, show(rendered)].join('\n\n'));
        const window = request.contextLength ?? 32768;
        const reserve = Math.min(request.maxOutputTokens, Math.floor(window / 4));
        if (Math.ceil(prompt.length / 4) + reserve > window) throw new Error('The ChatGPT Chat request exceeds its configured context budget. No message was submitted. Reduce attached context or loaded connector tools.');
        attempted = true;
        // The page holds the conversation so far when this is its next message: then only what was added is typed.
        const resume = continuesConversation(held, system, rendered) ? held : null;
        held = null;
        // What the person picked: the model, and the stop of ChatGPT's own effort slider that the effort stands for.
        const selection = selectionFor(picker.length > 0 ? picker : await scan(), request.model, request.effort);
        // A conversation that goes on takes the files of the new messages; a new chat takes the latest ones.
        const refs = (resume ? files.slice(resume.messages.length).flat() : files.flat()).slice(-MAX_FILES);
        const attached = await Promise.all(refs.map(async (ref) => {
          const bytes = await deps.readBlob(ref.blob);
          if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${ref.name} is larger than the 20 MB ChatGPT takes. Use a smaller file.`);
          return { name: ref.name, mime: ref.mime, data: toBase64(bytes) };
        }));
        const temporary = instance.temporaryChat !== false;
        const starting = bridge.request('start', JSON.stringify({ id, prompt, token: id, temporary, ...(resume ? { parent: resume.token, delta: remind(show(rendered.slice(resume.messages.length))) } : {}), ...(selection ? { model: selection.model, ...(selection.stop ? { stop: selection.stop } : {}) } : {}), ...(attached.length > 0 ? { files: attached } : {}) }));
        request.signal.addEventListener('abort', onAbort, { once: true });
        if (request.signal.aborted) onAbort();
        await starting;
        let previous = '';
        let thinkingShown = false;
        let corrections = 0;
        while (!request.signal.aborted) {
          const state = JSON.parse(await bridge.request('poll', id)) as { text: string; done: boolean; error?: string; thinking?: boolean; ownTools?: boolean };
          if (request.signal.aborted) break;
          if (state.error) throw new Error(state.error);
          if (withTools) state.text = unfenceToolCalls(state.text);
          // Before the first word, the page is thinking (a higher effort setting takes minutes): say so instead of nothing.
          if (state.thinking && !thinkingShown) {
            thinkingShown = true;
            yield { type: 'phase', phase: 'thinking' };
          }
          // Empty snapshots can be a renderer remount, not a retraction of the answer.
          if (state.text && state.text !== previous) {
            if (state.text.startsWith(previous)) yield { type: 'text', delta: state.text.slice(previous.length) };
            else yield { type: 'text_snapshot', text: state.text };
            previous = state.text;
          }
          if (state.done) {
            // No tool call, though tools were given: the page's own sandbox answered (whatever it reports never happened
            // here), or it declined and asked the person to do it. It is told so in the same chat, and what it said is taken
            // back, before the person gets that reply. A sandbox that goes on answering fails the turn; a refusal that stands is
            // the answer.
            const missed = withTools && !previous.includes('<tool_call>') && (state.ownTools === true || needsToolCall(previous));
            if (missed && corrections < MAX_CORRECTIONS) {
              corrections++;
              yield { type: 'text_snapshot', text: '' };
              previous = '';
              thinkingShown = false;
              const finished = id;
              id = randomUUID();
              stopping = undefined;
              await bridge.request('start', JSON.stringify({ id, prompt, token: id, temporary, parent: finished, delta: remind(show([{ role: 'user', text: TOOL_CORRECTION }])) }));
              continue;
            }
            if (missed && state.ownTools) throw new Error('ChatGPT used its own sandbox instead of Atelier’s tools, so what it reports did not happen on your computer. Send the message again.');
            held = { token: id, system, messages: [...rendered, { role: 'assistant', text: previous }] };
            break;
          }
          await new Promise<void>((resolve) => { const timer = setTimeout(done, 250); function done() { clearTimeout(timer); request.signal.removeEventListener('abort', done); resolve(); } request.signal.addEventListener('abort', done, { once: true }); });
        }
        if (request.signal.aborted) terminal = { type: 'finish', reason: 'aborted' };
      } catch (error) {
        terminal = { type: 'finish', reason: request.signal.aborted ? 'aborted' : 'error', ...(!request.signal.aborted ? { error: { code: 'provider_error', message: error instanceof Error ? error.message : 'ChatGPT Chat failed.', retryable: false } } : {}) };
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        if (attempted) await stop();
      }
      yield terminal;
    },
  };
}
