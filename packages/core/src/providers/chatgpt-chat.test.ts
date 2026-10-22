import { describe, expect, it } from 'vitest';
import { continuesConversation, createChatGptChatAdapter, TOOL_FRAMING, TOOL_NOTE, needsToolCall, TOOL_CORRECTION, TOOL_REMINDER, unfenceToolCalls, type ChatGptChatPort } from './chatgpt-chat.ts';
import { createAdapter } from './index.ts';
import { withPromptedTools } from './prompted-tools.ts';
import { RequestScheduler } from './scheduler.ts';
import type { Part } from '@atelier/protocol';
import { chatRequest, collect, message, providerInstance, userText } from './__fixtures__/harness.ts';

const instance = providerInstance('chatgpt-chat', 'https://chatgpt.com');
const deps = (chatgptChat: ChatGptChatPort) => ({ fetch: async () => Response.json({}), readBlob: async () => new Uint8Array(), chatgptChat });

function browser(states: { text: string; done: boolean; error?: string }[]) {
  let active: string | null = null;
  const calls: string[] = [];
  const ids: string[] = [];
  const bridge: ChatGptChatPort = {
    async request(operation, value) {
      if (operation === 'models') return '{}';
      calls.push(operation);
      if (operation === 'start') {
        if (active) throw new Error('Already generating');
        const payload = JSON.parse(value!) as { id: string; prompt: string };
        expect(payload.prompt).toContain('Hello');
        active = payload.id;
        ids.push(active);
      } else if (operation === 'poll') {
        expect(value).toBe(active);
        return JSON.stringify(states.shift() ?? { text: 'Hello there', done: true });
      } else if (operation === 'stop' && value === active) active = null;
      return '{}';
    },
  };
  return { bridge, calls, ids, active: () => active };
}

describe('ChatGPT Chat', () => {
  it('surfaces browser failures without retrying or submitting again', async () => {
    const b = browser([{ text: '', done: false, error: 'Usage limit reached' }]);
    const events = await collect(createChatGptChatAdapter(instance, deps(b.bridge)).stream(chatRequest()));
    expect(events).toEqual([{ type: 'finish', reason: 'error', error: { code: 'provider_error', message: 'Usage limit reached', retryable: false } }]);
    expect(b.calls).toEqual(['start', 'poll', 'stop']);
    expect(b.active()).toBeNull();
  });

  it('streams incremental browser text and releases the generation before finish', async () => {
    const b = browser([{ text: 'Hello', done: false }, { text: 'Hello there', done: true }]);
    const events = [];
    for await (const event of createChatGptChatAdapter(instance, deps(b.bridge)).stream(chatRequest())) {
      events.push(event);
      if (event.type === 'finish') {
        expect(b.active()).toBeNull();
        break;
      }
    }
    expect(events).toEqual([{ type: 'text', delta: 'Hello' }, { type: 'text', delta: ' there' }, { type: 'finish', reason: 'end' }]);
    expect(b.calls).toEqual(['start', 'poll', 'poll', 'stop']);
  });

  it('releases through all provider wrappers when stopped on a text delta', async () => {
    const b = browser([{ text: 'Hello', done: false }]);
    const adapter = withPromptedTools(createAdapter(instance, deps(b.bridge)));
    for await (const event of adapter.stream(chatRequest())) {
      if (event.type === 'text_snapshot') break;
    }
    expect(b.active()).toBeNull();
    expect(b.calls).toEqual(['start', 'poll', 'stop']);
  });

  it('reconciles formatted text revisions and temporary remounts without resubmitting', async () => {
    const b = browser([
      { text: 'A **cool', done: false },
      { text: 'A cool lab', done: false },
      { text: '', done: false },
      { text: 'A cool lab.', done: true },
    ]);
    const events = await collect(createChatGptChatAdapter(instance, deps(b.bridge)).stream(chatRequest()));
    expect(events).toEqual([
      { type: 'text', delta: 'A **cool' },
      { type: 'text_snapshot', text: 'A cool lab' },
      { type: 'text', delta: '.' },
      { type: 'finish', reason: 'end' },
    ]);
    expect(b.calls.filter(c => c === 'start')).toHaveLength(1);
    expect(b.active()).toBeNull();
  });

  it('cancels after a revised preview and immediately accepts a follow-up', async () => {
    const b = browser([
      { text: 'Hello provisional', done: false },
      { text: 'Hello revised', done: false },
      { text: 'Hello next', done: true },
    ]);
    const adapter = withPromptedTools(createAdapter(instance, deps(b.bridge)));
    const controller = new AbortController();
    const events = [];
    for await (const event of adapter.stream(chatRequest({ signal: controller.signal }))) {
      events.push(event);
      if (event.type === 'text_snapshot' && event.text === 'Hello revised') controller.abort();
    }
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'aborted' });
    expect(b.active()).toBeNull();
    expect((await collect(adapter.stream(chatRequest()))).at(-1)).toEqual({ type: 'finish', reason: 'end' });
    expect(b.calls).toEqual(['start', 'poll', 'poll', 'stop', 'start', 'poll', 'stop']);
  });

  it('serializes simultaneous requests and allows an immediate follow-up', async () => {
    const b = browser([{ text: 'Hello', done: false }, { text: 'Hello there', done: true }]);
    const scheduler = new RequestScheduler();
    const adapter = withPromptedTools(scheduler.wrap(createAdapter(instance, deps(b.bridge)), 'browser', () => ({ parallel: 1, modelsAtOnce: 1 })));
    const first = collect(adapter.stream(chatRequest()));
    const second = collect(adapter.stream(chatRequest()));
    for (const events of await Promise.all([first, second])) expect(events.at(-1)).toEqual({ type: 'finish', reason: 'end' });
    expect((await collect(adapter.stream(chatRequest()))).at(-1)).toEqual({ type: 'finish', reason: 'end' });
    expect(b.calls).toEqual(['start', 'poll', 'poll', 'stop', 'start', 'poll', 'stop', 'start', 'poll', 'stop']);
    expect(new Set(b.ids).size).toBe(3);
    expect(scheduler.load('browser')).toEqual({ running: 0, queued: 0, agents: 0 });
  });

  it('cancels a browser start that has not returned yet', async () => {
    let started!: () => void;
    let release!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<string>(resolve => { release = () => resolve('{}'); });
    const calls: { operation: string; id: string }[] = [];
    const bridge: ChatGptChatPort = {
      async request(operation, value) {
        if (operation === 'models') return '{}';
        const id = operation === 'start' ? (JSON.parse(value!) as { id: string }).id : value!;
        calls.push({ operation, id });
        if (operation === 'start') { started(); return pending; }
        if (operation === 'stop') release();
        return '{}';
      },
    };
    const controller = new AbortController();
    const result = collect(createChatGptChatAdapter(instance, deps(bridge)).stream(chatRequest({ signal: controller.signal })));
    await starting;
    controller.abort();
    expect(await result).toEqual([{ type: 'finish', reason: 'aborted' }]);
    expect(calls.map(c => c.operation)).toEqual(['start', 'stop']);
    expect(calls[1]!.id).toBe(calls[0]!.id);
  });

  it('does not release another request when its own start is refused', async () => {
    const b = browser([{ text: 'Hello', done: false }]);
    const adapter = createChatGptChatAdapter(instance, deps(b.bridge));
    const first = adapter.stream(chatRequest())[Symbol.asyncIterator]();
    expect(await first.next()).toMatchObject({ value: { type: 'text', delta: 'Hello' } });
    const owner = b.active();
    const refused = await collect(adapter.stream(chatRequest()));
    expect(refused).toEqual([{ type: 'finish', reason: 'error', error: { code: 'provider_error', message: 'Already generating', retryable: false } }]);
    expect(b.active()).toBe(owner);
    await first.return?.();
    expect(b.active()).toBeNull();
  });

  it('refuses an oversized request before touching the browser instead of truncating it', async () => {
    const b = browser([]);
    const events = await collect(createChatGptChatAdapter(instance, deps(b.bridge)).stream(chatRequest({ system: [{ text: 'x'.repeat(140000) }] })));
    expect(events).toEqual([{ type: 'finish', reason: 'error', error: { code: 'provider_error', message: expect.stringContaining('exceeds its configured context budget'), retryable: false } }]);
    expect(b.calls).toEqual([]);
  });

  it('does not open or stop the browser for an already cancelled request', async () => {
    const b = browser([]);
    const events = await collect(createChatGptChatAdapter(instance, deps(b.bridge)).stream(chatRequest({ signal: AbortSignal.abort() })));
    expect(events).toEqual([{ type: 'finish', reason: 'aborted' }]);
    expect(b.calls).toEqual([]);
  });

  describe('continuing the conversation the page holds', () => {
    /** A page that records what each request typed. */
    function recording() {
      const starts: { prompt: string; token: string; parent?: string; delta?: string; temporary: boolean }[] = [];
      const bridge: ChatGptChatPort = {
        async request(operation, value) {
          if (operation === 'start') starts.push(JSON.parse(value!));
          if (operation === 'poll') return JSON.stringify({ text: `Reply ${starts.length}`, done: true });
          return '{}';
        },
      };
      return { bridge, starts };
    }
    const assistantText = (text: string) => message('assistant', [{ type: 'text', text }]);

    it('types only the new messages of the next request, and the whole conversation when it cannot continue', async () => {
      const r = recording();
      const adapter = createChatGptChatAdapter(instance, deps(r.bridge));
      await collect(adapter.stream(chatRequest({ messages: [userText('One')] })));
      // Atelier stores the reply reshaped (here with a trailing space); the page has it as it wrote it.
      await collect(adapter.stream(chatRequest({ messages: [userText('One'), assistantText('Reply 1 '), userText('Two')] })));
      expect(r.starts[0]).toMatchObject({ prompt: 'You are helpful.\n\n[user]\nOne', temporary: true });
      expect(r.starts[0]!.parent).toBeUndefined();
      expect(r.starts[1]).toMatchObject({ parent: r.starts[0]!.token, delta: '[user]\nTwo', prompt: 'You are helpful.\n\n[user]\nOne\n\n[assistant]\nReply 1 \n\n[user]\nTwo' });
      // Edited history (what the person said before is not what the page holds): everything again, in a new chat.
      await collect(adapter.stream(chatRequest({ messages: [userText('One!'), assistantText('Reply 2'), userText('Three')] })));
      expect(r.starts[2]!.parent).toBeUndefined();
      expect(r.starts[2]!.delta).toBeUndefined();
      // The one after a restart of a conversation continues from the new chat.
      await collect(adapter.stream(chatRequest({ messages: [userText('One!'), assistantText('Reply 3'), userText('Three'), assistantText('x'), userText('Four')] })));
      expect(r.starts[3]).toMatchObject({ parent: r.starts[2]!.token, delta: '[user]\nFour' });
    });

    it('chats in temporary chats unless the provider is set not to', async () => {
      const r = recording();
      await collect(createChatGptChatAdapter(instance, deps(r.bridge)).stream(chatRequest()));
      await collect(createChatGptChatAdapter({ ...instance, temporaryChat: false }, deps(r.bridge)).stream(chatRequest()));
      expect(r.starts.map((start) => start.temporary)).toEqual([true, false]);
    });

    it('does not continue after a reply that did not finish', async () => {
      const starts: { parent?: string }[] = [];
      const bridge: ChatGptChatPort = {
        async request(operation, value) {
          if (operation === 'start') starts.push(JSON.parse(value!));
          if (operation === 'poll') return JSON.stringify(starts.length === 1 ? { text: 'Half', done: false, error: 'Usage limit reached' } : { text: 'Fine', done: true });
          return '{}';
        },
      };
      const adapter = createChatGptChatAdapter(instance, deps(bridge));
      await collect(adapter.stream(chatRequest({ messages: [userText('One')] })));
      await collect(adapter.stream(chatRequest({ messages: [userText('One'), assistantText('Half'), userText('Two')] })));
      expect(starts[1]!.parent).toBeUndefined();
    });

    it('needs the same system prompt and at least one new message', () => {
      const held = { token: 't', system: 'S', messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] };
      const next = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'other' }, { role: 'user', text: 'c' }];
      expect(continuesConversation(held, 'S', next)).toBe(true);
      expect(continuesConversation(held, 'S2', next)).toBe(false);
      expect(continuesConversation(held, 'S', next.slice(0, 2))).toBe(false);
      expect(continuesConversation(held, 'S', [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'user', text: 'c' }])).toBe(false);
      expect(continuesConversation(null, 'S', next)).toBe(false);
    });
  });

  describe('tool calls', () => {
    const call = '<tool_call>{"name": "Read", "arguments": {"path": "src/__init__.py", "glob": "**/*.ts"}}</tool_call>';

    it('takes the fence off a call, a finished one and one still being written', () => {
      expect(unfenceToolCalls(`Looking.\n\n\`\`\`\n${call}\n\`\`\``)).toBe(`Looking.\n\n${call}`);
      expect(unfenceToolCalls(`\`\`\`json\n${call}\n\`\`\`\n`)).toBe(`${call}\n`);
      expect(unfenceToolCalls(`Looking.\n\n\`\`\`\n<tool_call>{"name": "Re`)).toBe('Looking.\n\n<tool_call>{"name": "Re');
      expect(unfenceToolCalls(`Done.\n\n\`\`\`python\nprint(1)\n\`\`\`\n\n${call}`)).toBe(`Done.\n\n\`\`\`python\nprint(1)\n\`\`\`\n\n${call}`);
      expect(unfenceToolCalls('no call here')).toBe('no call here');
    });

    it('asks for fenced calls and no built-in tools only when tools are given, and hands the parser an unfenced call', async () => {
      const prompts: string[] = [];
      const bridge: ChatGptChatPort = {
        async request(operation, value) {
          if (operation === 'start') prompts.push((JSON.parse(value!) as { prompt: string }).prompt);
          if (operation === 'poll') return JSON.stringify({ text: `Reading.\n\n\`\`\`\n${call}\n\`\`\``, done: true });
          return '{}';
        },
      };
      const adapter = createChatGptChatAdapter(instance, deps(bridge));
      const withTools = await collect(adapter.stream(chatRequest({ system: [{ text: 'Be useful.\n\n# Tools\n<tool_call>{}</tool_call>' }] })));
      expect(prompts[0]).toContain(TOOL_NOTE);
      // The framing opens the message, and the reminder ends it.
      expect(prompts[0]!.startsWith(TOOL_FRAMING)).toBe(true);
      expect(prompts[0]!.endsWith(TOOL_REMINDER)).toBe(true);
      expect(withTools).toEqual([{ type: 'text', delta: `Reading.\n\n${call}` }, { type: 'finish', reason: 'end' }]);
      await collect(adapter.stream(chatRequest()));
      expect(prompts[1]).not.toContain('# How this chat works');
      expect(prompts[1]).not.toContain(TOOL_REMINDER);
    });

    it('ends the next message of a conversation with the reminder too, so a long session keeps the framing', async () => {
      const starts: { delta?: string }[] = [];
      const bridge: ChatGptChatPort = {
        async request(operation, value) {
          if (operation === 'start') starts.push(JSON.parse(value!));
          if (operation === 'poll') return JSON.stringify({ text: 'Reading.', done: true });
          return '{}';
        },
      };
      const adapter = createChatGptChatAdapter(instance, deps(bridge));
      const system = [{ text: 'Be useful.\n\n# Tools\n<tool_call>{}</tool_call>' }];
      await collect(adapter.stream(chatRequest({ system, messages: [userText('One')] })));
      await collect(adapter.stream(chatRequest({ system, messages: [userText('One'), message('assistant', [{ type: 'text', text: 'Reading.' }]), userText('Two')] })));
      expect(starts[1]!.delta).toBe(`[user]\nTwo\n\n${TOOL_REMINDER}`);
    });

    it('says the page is thinking before the first word', async () => {
      const polls = [{ text: '', done: false, thinking: true }, { text: '', done: false, thinking: true }, { text: 'Done.', done: true }];
      const bridge: ChatGptChatPort = { async request(operation) { return operation === 'poll' ? JSON.stringify(polls.shift() ?? polls[0]) : '{}'; } };
      const events = await collect(createChatGptChatAdapter(instance, deps(bridge)).stream(chatRequest()));
      expect(events.filter((event) => event.type === 'phase')).toEqual([{ type: 'phase', phase: 'thinking' }]);
    });

    it('sends a reply from ChatGPT’s own sandbox back in the same chat, and takes what it said back', async () => {
      const system = [{ text: 'Be useful.\n\n# Tools\n<tool_call>{}</tool_call>' }];
      const starts: { id: string; parent?: string; delta?: string }[] = [];
      const answers = [{ text: 'It printed hello.', done: true, ownTools: true }, { text: `\`\`\`\n<tool_call>{"name": "Bash", "arguments": {"command": "echo hello"}}</tool_call>\n\`\`\``, done: true }];
      const bridge: ChatGptChatPort = {
        async request(operation, value) {
          if (operation === 'start') starts.push(JSON.parse(value!));
          if (operation === 'poll') return JSON.stringify(answers.length > 1 ? answers.shift() : answers[0]);
          return '{}';
        },
      };
      const events = await collect(createChatGptChatAdapter(instance, deps(bridge)).stream(chatRequest({ system })));
      expect(starts).toHaveLength(2);
      expect(starts[1]).toMatchObject({ parent: starts[0]!.id });
      expect(starts[1]!.delta).toBe(`[user]\n${TOOL_CORRECTION}\n\n${TOOL_REMINDER}`);
      expect(events).toEqual([
        { type: 'text', delta: 'It printed hello.' },
        { type: 'text_snapshot', text: '' },
        { type: 'text', delta: '<tool_call>{"name": "Bash", "arguments": {"command": "echo hello"}}</tool_call>' },
        { type: 'finish', reason: 'end' },
      ]);
    });

    it('recognizes a reply that declines the tools or reports what its own sandbox found, and leaves real answers alone', () => {
      for (const reply of [
        'I can’t access `notes.txt` through the repository tools described in your message. Please paste its contents here.',
        'I can’t run `npm test` in your repository from this chat, so I can’t verify whether the tests pass.',
        'I couldn’t find `notes.txt` in the current directory. Please provide the file or its location.',
        'I can’t execute commands on your computer or access its shell through this chat.',
        'The current working directory is `/`.\n\n```\nbin\nboot\n```',
        'No files ending in `.test.ts` were found in the accessible directories. Please run this yourself.',
        'Created `hello.txt` in /mnt/data containing hi.',
      ]) expect(needsToolCall(reply), reply).toBe(true);
      for (const reply of [
        'The first word is **zebra**.',
        'All 12 tests pass.',
        'Done. I created hello.txt with the word hi.',
        'Recursion is when a function calls itself; each call works on a smaller problem.',
        'The result says the file was not found, so I will look in the parent folder next.',
      ]) expect(needsToolCall(reply), reply).toBe(false);
    });

    it('sends a refusal back once in the same chat, and keeps it as the answer if ChatGPT stands by it', async () => {
      const system = [{ text: 'Be useful.\n\n# Tools\n<tool_call>{}</tool_call>' }];
      const starts: { delta?: string }[] = [];
      const bridge: ChatGptChatPort = {
        async request(operation, value) {
          if (operation === 'start') starts.push(JSON.parse(value!));
          return operation === 'poll' ? JSON.stringify({ text: 'I can’t run `npm test` from this chat. Please paste the output.', done: true }) : '{}';
        },
      };
      const events = await collect(createChatGptChatAdapter(instance, deps(bridge)).stream(chatRequest({ system })));
      expect(starts).toHaveLength(3);
      expect(starts[1]!.delta).toContain(TOOL_CORRECTION);
      // Without the page's sandbox in it, a refusal that stands is the reply, not a failure.
      expect(events.at(-1)).toEqual({ type: 'finish', reason: 'end' });
      expect(events.filter((event) => event.type === 'text').map((event) => event.delta).join('')).toContain('I can’t run `npm test`');
    });

    it('fails, saying so, when ChatGPT keeps answering from its sandbox, and leaves its sandbox alone in a chat without tools', async () => {
      const starts: unknown[] = [];
      const stubborn: ChatGptChatPort = { async request(operation, value) { if (operation === 'start') starts.push(JSON.parse(value!)); return operation === 'poll' ? JSON.stringify({ text: 'It printed hello.', done: true, ownTools: true }) : '{}'; } };
      const events = await collect(createChatGptChatAdapter(instance, deps(stubborn)).stream(chatRequest({ system: [{ text: 'Be useful.\n\n# Tools\n<tool_call>{}</tool_call>' }] })));
      expect(starts).toHaveLength(3);
      expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'error', error: { message: expect.stringContaining('own sandbox') } });
      const plain = await collect(createChatGptChatAdapter(instance, deps(stubborn)).stream(chatRequest()));
      expect(plain.at(-1)).toEqual({ type: 'finish', reason: 'end' });
    });
  });

  describe('models, effort and attachments', () => {
    const stops = (...labels: string[]) => labels.map((label) => ({ label, locked: false }));
    const scanned = { models: [{ name: '6', stops: stops('Instant', 'Medium', 'High', 'Extra High', 'Pro') }, { name: 'GPT-5.6 Sol', stops: stops('Instant', 'Medium', 'High', 'Extra High', 'Pro') }] };
    const bytesOf = (blob: string) => new TextEncoder().encode(`bytes of ${blob}`);

    function page(options: { models?: unknown } = {}) {
      const starts: Record<string, unknown>[] = [];
      const bridge: ChatGptChatPort = {
        async request(operation, value) {
          if (operation === 'models') return JSON.stringify(options.models ?? scanned);
          if (operation === 'start') starts.push(JSON.parse(value!));
          if (operation === 'poll') return JSON.stringify({ text: 'ok', done: true });
          return '{}';
        },
      };
      const adapter = createChatGptChatAdapter(instance, { fetch: async () => Response.json({}), readBlob: async (blob: string) => bytesOf(blob), chatgptChat: bridge });
      return { adapter, starts };
    }
    const image = (blob: string): Part => ({ type: 'image', mime: 'image/png', blob });

    it('lists the models of the picker, and the page’s own when it cannot be read', async () => {
      expect((await page().adapter.listModels()).map((model) => model.modelId)).toEqual(['gpt-6', 'gpt-5.6-sol']);
      const empty = await page({ models: { models: [] } }).adapter.listModels();
      expect(empty.map((model) => model.modelId)).toEqual(['current']);
    });

    it('sets the model and the stop the effort stands for, and leaves the page alone for a model it does not know', async () => {
      const { adapter, starts } = page();
      await adapter.listModels();
      await collect(adapter.stream(chatRequest({ model: 'gpt-6', effort: 'xhigh' })));
      await collect(adapter.stream(chatRequest({ model: 'gpt-5.6-sol', effort: 'low' })));
      await collect(adapter.stream(chatRequest({ model: 'current', effort: 'high' })));
      expect(starts.map((start) => [start.model, start.stop])).toEqual([['6', { index: 4, label: 'Extra High' }], ['GPT-5.6 Sol', { index: 1, label: 'Instant' }], [undefined, undefined]]);
    });

    it('sends an image as a file named in the text, and a text document inside the text', async () => {
      const { adapter, starts } = page();
      const doc: Part = { type: 'document', mime: 'text/plain', blob: 'notes', name: 'notes.txt' };
      await collect(adapter.stream(chatRequest({ messages: [message('user', [{ type: 'text', text: 'Look' }, image('aaa'), doc])] })));
      const start = starts[0] as { prompt: string; files: { name: string; mime: string; data: string }[] };
      expect(start.prompt).toContain('[user]\nLook\n[attached image: image-1.png]\n<document name="notes.txt">\nbytes of notes\n</document>');
      expect(start.files).toEqual([{ name: 'image-1.png', mime: 'image/png', data: btoa('bytes of aaa') }]);
    });

    it('sends only the files of the new messages when the conversation goes on', async () => {
      const { adapter, starts } = page();
      await collect(adapter.stream(chatRequest({ messages: [message('user', [{ type: 'text', text: 'One' }, image('aaa')])] })));
      await collect(adapter.stream(chatRequest({ messages: [message('user', [{ type: 'text', text: 'One' }, image('aaa')]), message('assistant', [{ type: 'text', text: 'ok' }]), message('user', [{ type: 'text', text: 'Two' }, image('bbb')])] })));
      const second = starts[1] as { delta: string; files: { name: string }[] };
      expect(second.delta).toBe('[user]\nTwo\n[attached image: image-2.png]');
      expect(second.files.map((file) => file.name)).toEqual(['image-2.png']);
    });

    it('sends a PDF as a file, and refuses a file ChatGPT would not take', async () => {
      const { adapter, starts } = page();
      await collect(adapter.stream(chatRequest({ messages: [message('user', [{ type: 'text', text: 'Read' }, { type: 'document', mime: 'application/pdf', blob: 'pdf', name: 'a/b.pdf' }])] })));
      expect(starts[0]!.files).toEqual([{ name: 'a_b.pdf', mime: 'application/pdf', data: btoa('bytes of pdf') }]);
      const big = createChatGptChatAdapter(instance, { fetch: async () => Response.json({}), readBlob: async () => new Uint8Array(21 * 1024 * 1024), chatgptChat: { request: async () => '{}' } });
      const events = await collect(big.stream(chatRequest({ messages: [message('user', [image('huge')])] })));
      expect(events).toEqual([{ type: 'finish', reason: 'error', error: { code: 'provider_error', message: expect.stringContaining('larger than the 20 MB'), retryable: false } }]);
    });
  });
});
