import { describe, expect, it } from 'vitest';
import { jsonResponse } from '../../../providers/__fixtures__/harness.ts';
import { createImageAdapter } from '../../index.ts';
import type { ImageAdapter, ImageEvent, ImageInstance, ImageRequest, ImageSocket } from '../../types.ts';
import { BASE, collectEvents, fakeServer, FakeSocket, historyEntry, IMAGE, imageRequest, instance, message as m, metadataFrame, nodesOf, PNG, previewFrame, sentGraph, type Server, type ServerOptions } from './__fixtures__/comfy.ts';
import { decodeFrame } from './frames.ts';
import { createComfyUi } from './index.ts';
import type { JobTiming } from './job.ts';

/** Quick enough that a test can wait for a look at the queue. */
const FAST: JobTiming = { silenceMs: 5, pollMs: 2, lostMs: 60, stallMs: 30, connectMs: 40, requestMs: 100 };

interface Setup extends ServerOptions {
  socket?: (server: Server) => Promise<ImageSocket>;
  instance?: ImageInstance;
  timing?: JobTiming;
}

function setup(options: Setup = {}): { server: Server; adapter: ImageAdapter; urls: string[] } {
  const server = fakeServer(options);
  const urls: string[] = [];
  const adapter = createComfyUi(options.instance ?? instance, {
    fetch: server.fetch,
    socket: (url) => {
      urls.push(url);
      return options.socket ? options.socket(server) : Promise.resolve(server.socket);
    },
  }, options.timing ?? FAST);
  return { server, adapter, urls };
}

const OUTPUT = '11';

const happyJob = (id: string, server: Server) => {
  server.socket.push(m.status(1), m.start(id), m.cached(id), m.executing(id, '1'), m.progressState(id), m.executing(id, '8'), m.progress(id, 1, 8, '8'), previewFrame(1), m.progress(id, 8, 8, '8'), m.executed(id, OUTPUT), m.success(id), m.executing(id, null));
};

const finishOf = (events: ImageEvent[]) => {
  const finishes = events.filter((e): e is Extract<ImageEvent, { type: 'finish' }> => e.type === 'finish');
  expect(finishes).toHaveLength(1);
  expect(events.at(-1)).toBe(finishes[0]);
  return finishes[0]!;
};

const paths = (server: Server) => server.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
const body = (server: Server, path: string) => server.calls.find((c) => c.method === 'POST' && new URL(c.url).pathname === path)?.body;
const until = async (ready: () => boolean, ms = 500) => {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 1));
  }
};

describe('registering the dialect', () => {
  it('builds the ComfyUI adapter for its provider type', () => {
    const adapter = createImageAdapter(instance, { fetch: fakeServer().fetch, socket: async () => new FakeSocket() });
    expect(adapter.type).toBe('comfyui');
  });
});

describe('health and discovery', () => {
  it('asks /system_stats', async () => {
    const { adapter, server } = setup();
    expect(await adapter.health()).toMatchObject({ ok: true, warnings: [] });
    expect(paths(server)).toEqual(['GET /system_stats']);
  });

  it('says so when something else answers on that port', async () => {
    const { adapter } = setup({ routes: { 'GET /system_stats': () => jsonResponse({ hello: 'world' }) } });
    expect(await adapter.health()).toMatchObject({ ok: false, error: expect.stringContaining("isn't ComfyUI") });
  });

  it('reports a server error', async () => {
    const { adapter } = setup({ routes: { 'GET /system_stats': () => new Response('nope', { status: 500 }) } });
    expect(await adapter.health()).toMatchObject({ ok: false });
  });

  it('asks about each node and never for the whole of /object_info, which can stop that server for minutes', async () => {
    const { adapter, server } = setup();
    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(paths(server).every((p) => p.startsWith('GET /object_info/'))).toBe(true);
  });

  it('takes a missing node as missing', async () => {
    const { FaceDetailer: _a, ...info } = (await import('./__fixtures__/comfy.ts')).OBJECT_INFO;
    const { adapter, server } = setup({ info });
    expect((await adapter.listModels()).length).toBeGreaterThan(0);
    expect(server.calls.some((c) => c.url.endsWith('/object_info/KSampler'))).toBe(true);
  });

  it('keeps what it read between jobs, and reads again when asked for the models', async () => {
    const { adapter, server } = setup({ onPrompt: happyJob });
    await adapter.listModels();
    const after = server.calls.length;
    await collectEvents(adapter.generate(imageRequest()));
    expect(server.calls.slice(after).some((c) => c.url.includes('/object_info/'))).toBe(false);
    await adapter.listModels();
    expect(server.calls.at(-1)?.url).toContain('/object_info/');
  });
});

describe('a job', () => {
  it('sends the graph with a client id and previews on, and connects first', async () => {
    const { adapter, server, urls } = setup({ onPrompt: happyJob });
    await collectEvents(adapter.generate(imageRequest()));
    const sent = body(server, '/prompt') as { client_id: string; prompt_id: string; extra_data: unknown; prompt: unknown };
    expect(sent.extra_data).toEqual({ preview_method: 'auto' });
    expect(sent.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.prompt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(urls).toEqual([`ws://192.168.77.20:8188/ws?clientId=${sent.client_id}`]);
  });

  it('turns an https address into wss', async () => {
    const { adapter, urls } = setup({ onPrompt: happyJob, instance: { ...instance, baseUrl: 'https://comfy.example.com' } });
    await collectEvents(adapter.generate(imageRequest()));
    expect(urls[0]).toMatch(/^wss:\/\/comfy\.example\.com\/ws\?clientId=/);
  });

  it('sends a key and custom headers to a server behind a proxy', async () => {
    const { adapter, server } = setup({ onPrompt: happyJob, instance: { ...instance, apiKey: 'sk-test', headers: { 'x-proxy': 'yes' } } });
    await collectEvents(adapter.generate(imageRequest()));
    expect(server.calls.find((c) => c.url.endsWith('/prompt'))?.headers).toMatchObject({ authorization: 'Bearer sk-test', 'x-proxy': 'yes' });
  });

  it('follows a job from load to image', async () => {
    const { adapter, server } = setup({ onPrompt: happyJob });
    const events = await collectEvents(adapter.generate(imageRequest({ seed: 42 })));
    expect(events.map((e) => e.type)).toEqual(['loading', 'progress', 'preview', 'progress', 'image', 'finish']);
    expect(events.find((e) => e.type === 'progress')).toMatchObject({ step: 1, steps: 8 });
    expect(events.find((e) => e.type === 'image')).toMatchObject({ bytes: PNG, seed: 42 });
    expect(finishOf(events).reason).toBe('done');
    expect(server.socket.closed).toBe(true);
    expect(server.calls.find((c) => c.url.includes('/view'))?.url).toBe(`${BASE}/view?filename=${IMAGE.filename}&subfolder=&type=temp`);
  });

  it('chooses a seed when none is asked for, and says which', async () => {
    const { adapter, server } = setup({ onPrompt: happyJob });
    const events = await collectEvents(adapter.generate(imageRequest()));
    const image = events.find((e): e is Extract<ImageEvent, { type: 'image' }> => e.type === 'image');
    expect(image?.seed).toEqual(expect.any(Number));
    expect(nodesOf(sentGraph(server), 'KSampler')[0]?.inputs.seed).toBe(image?.seed);
    expect(Number.isSafeInteger(image?.seed)).toBe(true);
  });

  it('fetches every image of a batch', async () => {
    const { adapter } = setup({
      onPrompt: (id, server) => server.socket.push(m.executed(id, OUTPUT, [IMAGE, { ...IMAGE, filename: 'b.png' }]), m.success(id)),
    });
    const events = await collectEvents(adapter.generate(imageRequest({ count: 2 })));
    expect(events.filter((e) => e.type === 'image')).toHaveLength(2);
  });

  it('counts anything before the first step as loading, once for each thing, naming what', async () => {
    const { adapter } = setup({
      onPrompt: (id, server) =>
        server.socket.push(
          m.executing(id, '1'), // UNETLoader
          m.executing(id, '2'), // CLIPLoader
          m.executing(id, '5'), // CLIPTextEncode
          m.executing(id, '3'), // VAELoader
          m.executing(id, '7'), // EmptySD3LatentImage
          m.executing(id, '8'), // KSampler
          m.progress(id, 1, 8, '8'),
          m.executing(id, '10'), // VAEDecode, after sampling
          m.executed(id, OUTPUT),
          m.success(id),
        ),
    });
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(events.filter((e) => e.type === 'loading')).toEqual([{ type: 'loading', what: 'the model' }, { type: 'loading', what: 'the text encoder' }, { type: 'loading', what: 'the VAE' }, { type: 'loading', what: 'the model' }]);
  });

  it('estimates the time left from the steps so far, leaving out the slow first one', async () => {
    const { adapter } = setup({
      onPrompt: async (id, server) => {
        server.queue.running = [id];
        server.socket.push(m.progress(id, 1, 8, '8'));
        await until(() => server.calls.some((c) => c.url.endsWith('/prompt')));
        await new Promise((r) => setTimeout(r, 30));
        server.socket.push(m.progress(id, 2, 8, '8'), m.executed(id, OUTPUT), m.success(id));
      },
    });
    const steps = (await collectEvents(adapter.generate(imageRequest()))).filter((e): e is Extract<ImageEvent, { type: 'progress' }> => e.type === 'progress');
    expect(steps[0]?.etaMs).toBeUndefined();
    // About 30 ms a step, six steps left.
    expect(steps.at(-1)?.etaMs).toBeGreaterThan(120);
    expect(steps.at(-1)?.etaMs).toBeLessThan(600);
  });

  it('moves one share forward across passes, where the step count starts over', async () => {
    const { adapter } = setup({
      onPrompt: (id, server) => {
        const samplers = Object.entries(sentGraph(server)).filter(([, n]) => /KSampler|FaceDetailer/.test(n.class_type)).map(([node]) => node);
        const output = Object.entries(sentGraph(server)).find(([, n]) => n.class_type === 'PreviewImage')?.[0] ?? '';
        expect(samplers).toHaveLength(3);
        server.socket.push(m.progress(id, 15, 30, samplers[0]!), m.progress(id, 4, 8, samplers[1]!), m.progress(id, 5, 10, samplers[2]!), m.executed(id, output), m.success(id));
      },
    });
    const capabilities = { ...imageRequest().capabilities, family: 'sdxl' };
    const events = await collectEvents(adapter.generate(imageRequest({ model: 'sd_xl_base_1.0.safetensors', capabilities, quality: 'high' })));
    const shares = events.flatMap((e) => (e.type === 'progress' ? [e.fraction] : []));
    expect(shares).toEqual([1 / 6, 0.5, 5 / 6]);
  });

  it('ignores what belongs to another job', async () => {
    const { adapter } = setup({
      onPrompt: (id, server) => {
        server.socket.push(m.progress('someone-else', 3, 8, '8'), m.executing('someone-else', '1'), m.executed('someone-else', OUTPUT, [{ ...IMAGE, filename: 'theirs.png' }]), m.error('someone-else'), metadataFrame({ prompt_id: 'someone-else' }), m.success('someone-else'));
        server.socket.push(m.executed(id, OUTPUT), m.success(id));
      },
    });
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(events.map((e) => e.type)).toEqual(['image', 'finish']);
    expect(finishOf(events).reason).toBe('done');
  });

  it('skips garbage on the socket', async () => {
    const { adapter } = setup({ onPrompt: (id, server) => server.socket.push('not json', new Uint8Array(3), { type: 'crystools.monitor', data: {} }, m.executed(id, OUTPUT), m.success(id)) });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).reason).toBe('done');
  });

  it('reports images from the server\'s record when a job was all cached', async () => {
    const { adapter, server } = setup({
      onPrompt: (id, s) => {
        s.history = historyEntry(id, OUTPUT);
        s.socket.push(m.cached(id, ['1', '2', '8', OUTPUT]), m.success(id));
      },
    });
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(events.filter((e) => e.type === 'image')).toHaveLength(1);
    expect(server.bodies.some((b) => b.url.includes('/history/'))).toBe(true);
  });

  it('says so when a job finishes without an image', async () => {
    const { adapter } = setup({ onPrompt: (id, s) => s.socket.push(m.success(id)) });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).error?.message).toContain('without an image');
  });

  it('fails cleanly when an image can\'t be fetched', async () => {
    const { adapter } = setup({ onPrompt: happyJob, routes: { 'GET /view': () => new Response('gone', { status: 404 }) } });
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(finishOf(events).reason).toBe('error');
  });

  it('cannot run a model that has left the server', async () => {
    const { adapter, server } = setup();
    const events = await collectEvents(adapter.generate(imageRequest({ model: 'deleted.safetensors' })));
    expect(finishOf(events).error?.message).toContain("can't run deleted.safetensors");
    expect(server.calls.some((c) => c.url.endsWith('/prompt'))).toBe(false);
  });

  it('frees the GPU with both flags', async () => {
    const { adapter, server } = setup();
    await adapter.free?.();
    expect(body(server, '/free')).toEqual({ unload_models: true, free_memory: true });
  });

  it('reports a server that refuses to free', async () => {
    const { adapter } = setup({ routes: { 'POST /free': () => new Response('no', { status: 500 }) } });
    await expect(adapter.free?.()).rejects.toThrow();
  });
});

describe('preview frames', () => {
  const data = (image: Uint8Array) => Buffer.from(image).toString('base64');
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);

  it('reads the two formats of type 1', () => {
    expect(decodeFrame(previewFrame(1, jpeg))).toEqual({ mime: 'image/jpeg', data: data(jpeg) });
    expect(decodeFrame(previewFrame(2, PNG))).toEqual({ mime: 'image/png', data: data(PNG) });
  });

  it('reads type 4 past its metadata, and which job it is for', () => {
    expect(decodeFrame(metadataFrame({ prompt_id: 'p1', node_id: '8', image_type: 'image/jpeg' }, jpeg))).toEqual({ mime: 'image/jpeg', data: data(jpeg), promptId: 'p1' });
  });

  it('works on a frame that sits inside a larger buffer', () => {
    const frame = previewFrame(1, jpeg);
    const larger = new Uint8Array(frame.length + 5);
    larger.set(frame, 5);
    expect(decodeFrame(larger.subarray(5))).toEqual({ mime: 'image/jpeg', data: data(jpeg) });
  });

  it('skips frames that are not previews, or are cut short', () => {
    const text = previewFrame(1);
    new DataView(text.buffer).setUint32(0, 3);
    expect(decodeFrame(text)).toBeNull();
    expect(decodeFrame(new Uint8Array(4))).toBeNull();
    expect(decodeFrame(previewFrame(9))).toBeNull();
    const long = metadataFrame({}, jpeg);
    new DataView(long.buffer).setUint32(4, 9999);
    expect(decodeFrame(long)).toBeNull();
  });

  it('survives metadata that is not JSON', () => {
    const frame = metadataFrame({}, jpeg);
    frame[8] = 0x7b;
    frame[9] = 0x7b;
    expect(decodeFrame(frame)).toEqual({ mime: 'image/jpeg', data: data(jpeg) });
  });
});

describe('when the socket lets us down', () => {
  it('polls from the start when it won\'t open', async () => {
    const { adapter, server } = setup({
      socket: async () => {
        throw new Error('no');
      },
      onPrompt: (id, s) => {
        s.queue.running = [id];
        setTimeout(() => {
          s.queue.running = [];
          s.history = historyEntry(id, OUTPUT);
        }, 8);
      },
    });
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(finishOf(events).reason).toBe('done');
    expect(events.filter((e) => e.type === 'image')).toHaveLength(1);
    // While polling there are no step counts, but the card still knows it's working.
    expect(events.some((e) => e.type === 'progress')).toBe(true);
    expect(paths(server)).toContain('GET /queue');
  });

  it('gives up on a socket that never answers, whether or not it honours the signal', async () => {
    const { adapter } = setup({
      socket: () => new Promise<ImageSocket>(() => undefined),
      onPrompt: (id, s) => {
        s.history = historyEntry(id, OUTPUT);
      },
    });
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(finishOf(events).reason).toBe('done');
  });

  it('closes a socket that opens too late to be used', async () => {
    let open: (socket: ImageSocket) => void = () => undefined;
    const late = new FakeSocket();
    const { adapter } = setup({
      socket: () => new Promise<ImageSocket>((resolve) => (open = resolve)),
      onPrompt: (id, s) => {
        s.history = historyEntry(id, OUTPUT);
      },
    });
    await collectEvents(adapter.generate(imageRequest()));
    open(late);
    await until(() => late.closed);
  });

  it('stops waiting for the connection when asked to stop', async () => {
    const stop = new AbortController();
    const { adapter } = setup({
      socket: () => {
        stop.abort(new Error('stopped'));
        return Promise.reject(new Error('closed'));
      },
    });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest({ signal: stop.signal })))).reason).toBe('aborted');
  });

  it('switches to polling when it drops mid job, keeping what it had', async () => {
    const { adapter, server } = setup({
      onPrompt: (id, s) => {
        s.queue.running = [id];
        s.socket.push(m.executing(id, '8'), m.progress(id, 3, 8, '8'));
        setTimeout(() => {
          s.socket.end();
          s.queue.running = [];
          s.history = historyEntry(id, OUTPUT);
        }, 4);
      },
    });
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(events.find((e) => e.type === 'progress')).toMatchObject({ step: 3 });
    expect(events.filter((e) => e.type === 'image')).toHaveLength(1);
    expect(finishOf(events).reason).toBe('done');
    expect(paths(server)).toContain('GET /queue');
  });

  it('switches to polling when it fails mid job', async () => {
    const { adapter } = setup({
      onPrompt: (id, s) => {
        s.history = historyEntry(id, OUTPUT);
        s.socket.fail();
      },
    });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).reason).toBe('done');
  });

  it('notices a job that finished while the socket stayed open and silent', async () => {
    const { adapter } = setup({
      onPrompt: (id, s) => {
        s.history = historyEntry(id, OUTPUT);
      },
    });
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(events.filter((e) => e.type === 'image')).toHaveLength(1);
  });

  it('reads a failure from the record when the socket missed it', async () => {
    const { adapter } = setup({
      onPrompt: (id, s) => {
        s.history = { [id]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_start', { prompt_id: id }], m.error(id, { exception_message: 'boom' }).type === 'execution_error' ? ['execution_error', m.error(id, { exception_message: 'boom' }).data] : []] } } };
        s.socket.end();
      },
    });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).error?.message).toBe('KSampler failed on ComfyUI: boom');
  });

  it('reads an interruption from the record the same way', async () => {
    const { adapter } = setup({
      onPrompt: (id, s) => {
        s.history = { [id]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', m.interrupted(id).data]] } } };
        s.socket.end();
      },
    });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).error?.message).toContain('stopped on ComfyUI itself');
  });

  it('says how many are ahead while a job waits on the server', async () => {
    const { adapter } = setup({
      onPrompt: (id, s) => {
        s.queue.running = ['theirs'];
        s.queue.pending = ['theirs-too', id];
        setTimeout(() => {
          s.queue = { running: [id], pending: [] };
          s.socket.push(m.executed(id, OUTPUT), m.success(id));
        }, 12);
      },
    });
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(events.find((e) => e.type === 'queued')).toEqual({ type: 'queued', ahead: 2 });
    expect(finishOf(events).reason).toBe('done');
  });

  it('reads the queue in the order jobs will run, not the order it is listed', async () => {
    const entry = (number: number, id: string) => [number, id, {}, {}, []];
    const { adapter } = setup({
      routes: {
        'GET /queue': (call) => jsonResponse({ queue_running: [entry(1, 'a')], queue_pending: [entry(9, (call.url && mine) || ''), entry(3, 'b'), entry(5, 'c')] }),
      },
      onPrompt: (id, s) => {
        mine = id;
        setTimeout(() => s.socket.push(m.executed(id, OUTPUT), m.success(id)), 12);
      },
    });
    let mine = '';
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(events.find((e) => e.type === 'queued')).toEqual({ type: 'queued', ahead: 3 });
  });

  it('gives up with a plain reason when a job disappears', async () => {
    const { adapter } = setup({ onPrompt: () => undefined });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).error).toMatchObject({ message: 'ComfyUI dropped this job from its queue, or restarted.', retryable: true });
  });

  it('puts up with a server that is slow to answer for a while', async () => {
    let answers = 0;
    const { adapter } = setup({
      routes: {
        'GET /queue': () => {
          if (++answers < 4) throw new TypeError('fetch failed');
          return jsonResponse({ queue_running: [], queue_pending: [] });
        },
      },
      onPrompt: (id, s) => {
        s.history = historyEntry(id, OUTPUT);
      },
    });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).reason).toBe('done');
    expect(answers).toBe(4);
  });

  it('gives up on a server that stays gone', async () => {
    const { adapter } = setup({
      routes: {
        'GET /queue': () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).error?.code).toBe('provider_offline');
  });

  it('says so when a server stops starting jobs, and takes the job back off its queue', async () => {
    const { adapter, server } = setup({
      onPrompt: (id, s) => {
        s.queue.pending = [id];
      },
      routes: {
        'POST /queue': () => {
          server.queue.pending = [];
          return jsonResponse({});
        },
      },
    });
    const events = await collectEvents(adapter.generate(imageRequest()));
    expect(finishOf(events).error?.message).toBe("ComfyUI isn't starting jobs: this one was next in line with nothing else running. Restart ComfyUI and try again.");
    expect(body(server, '/queue')).toEqual({ delete: [server.promptId()] });
    expect(paths(server)).not.toContain('POST /interrupt');
  });

  it('waits as long as it takes behind another job', async () => {
    const { adapter, server } = setup({
      onPrompt: (id, s) => {
        s.queue = { running: ['theirs'], pending: [id] };
        setTimeout(() => {
          s.queue = { running: [id], pending: [] };
          s.socket.push(m.executed(id, OUTPUT), m.success(id));
        }, FAST.stallMs * 2);
      },
    });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).reason).toBe('done');
    expect(paths(server)).not.toContain('POST /queue');
  });
});

describe('stopping', () => {
  function stoppable(place: (id: string, s: Server) => void, routes?: ServerOptions['routes']) {
    const stop = new AbortController();
    const made = setup({
      timing: { ...FAST, silenceMs: 10_000 },
      routes,
      onPrompt: (id, s) => {
        place(id, s);
        stop.abort(new Error('stopped'));
      },
    });
    return { ...made, run: () => collectEvents(made.adapter.generate(imageRequest({ signal: stop.signal }))) };
  }

  it('interrupts only when the running job is ours, and names it', async () => {
    const t = stoppable((id, s) => {
      s.queue.running = [id];
    });
    expect(finishOf(await t.run()).reason).toBe('aborted');
    expect(body(t.server, '/interrupt')).toEqual({ prompt_id: t.server.promptId() });
    expect(paths(t.server)).not.toContain('POST /queue');
  });

  it('takes a waiting job off the queue and leaves the running one alone', async () => {
    const t = stoppable(
      (id, s) => {
        s.queue = { running: ['someone-elses'], pending: [id] };
      },
      {
        'POST /queue': () => jsonResponse({}),
      },
    );
    const finished = t.run();
    await until(() => paths(t.server).includes('POST /queue'));
    t.server.queue.pending = [];
    expect(finishOf(await finished).reason).toBe('aborted');
    expect(body(t.server, '/queue')).toEqual({ delete: [t.server.promptId()] });
    expect(paths(t.server)).not.toContain('POST /interrupt');
  });

  it('does nothing to a job that already ended', async () => {
    const t = stoppable(() => undefined);
    expect(finishOf(await t.run()).reason).toBe('aborted');
    expect(paths(t.server)).not.toContain('POST /interrupt');
    expect(paths(t.server)).not.toContain('POST /queue');
  });

  it('never interrupts someone else\'s job when ours is nowhere', async () => {
    const t = stoppable((_id, s) => {
      s.queue.running = ['someone-elses'];
    });
    await t.run();
    expect(paths(t.server)).not.toContain('POST /interrupt');
  });

  it('catches a job that started between the two looks', async () => {
    const t = stoppable(
      (id, s) => {
        s.queue.pending = [id];
      },
      {
        'POST /queue': () => {
          t.server.queue = { running: [t.server.promptId()], pending: [] };
          return jsonResponse({});
        },
      },
    );
    expect(finishOf(await t.run()).reason).toBe('aborted');
    expect(paths(t.server)).toContain('POST /interrupt');
  });

  it('stops by the id it chose, even if the answer to the submit never came', async () => {
    const stop = new AbortController();
    const { adapter, server } = setup({
      promptResponse: (id) => {
        server.queue.pending = [id];
        stop.abort(new Error('stopped'));
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
      routes: {
        'POST /queue': () => {
          server.queue.pending = [];
          return jsonResponse({});
        },
      },
    });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest({ signal: stop.signal })))).reason).toBe('aborted');
    expect(body(server, '/queue')).toEqual({ delete: [server.promptId()] });
  });

  it('still ends as stopped when the server can\'t be reached to stop it', async () => {
    const t = stoppable(() => undefined, {
      'GET /queue': () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(finishOf(await t.run()).reason).toBe('aborted');
  });

  it('closes the socket when stopped', async () => {
    const t = stoppable(() => undefined);
    await t.run();
    expect(t.server.socket.closed).toBe(true);
  });

  it('reports a timeout as an error, and stops the job all the same', async () => {
    const timeout = new AbortController();
    const { adapter, server } = setup({
      timing: { ...FAST, silenceMs: 10_000 },
      onPrompt: (id, s) => {
        s.queue.running = [id];
        timeout.abort(new DOMException('took too long', 'TimeoutError'));
      },
    });
    const finish = finishOf(await collectEvents(adapter.generate(imageRequest({ signal: timeout.signal }))));
    expect(finish.error?.code).toBe('provider_timeout');
    expect(paths(server)).toContain('POST /interrupt');
  });

  it('reports a job someone else stopped on the server, and doesn\'t call that ours', async () => {
    const { adapter } = setup({ onPrompt: (id, s) => s.socket.push(m.interrupted(id)) });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).error?.message).toBe('This job was stopped on ComfyUI itself.');
  });
});

describe('errors in plain words', () => {
  const refused = (body: unknown, status = 400): Setup => ({ promptResponse: () => jsonResponse(body, status) });
  const VALUE_NOT_IN_LIST = {
    error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
    node_errors: {
      '1': {
        errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "ckpt_name: 'foo.safetensors' not in ['bar.safetensors']", extra_info: { input_name: 'ckpt_name', input_config: [['bar.safetensors'], {}], received_value: 'foo.safetensors' } }],
        dependent_outputs: ['11'],
        class_type: 'CheckpointLoaderSimple',
      },
    },
  };

  const errorFrom = async (options: Setup) => {
    const { adapter } = setup(options);
    return finishOf(await collectEvents(adapter.generate(imageRequest()))).error;
  };

  it('names a missing model', async () => {
    expect((await errorFrom(refused(VALUE_NOT_IN_LIST)))?.message).toBe('Missing model foo.safetensors');
  });

  it('forgets what the server had when it says a file is gone', async () => {
    const { adapter, server } = setup(refused(VALUE_NOT_IN_LIST));
    await collectEvents(adapter.generate(imageRequest()));
    const before = server.calls.filter((c) => c.url.includes('/object_info/')).length;
    await collectEvents(adapter.generate(imageRequest()));
    expect(server.calls.filter((c) => c.url.includes('/object_info/')).length).toBeGreaterThan(before);
  });

  it('joins several problems, without repeats', async () => {
    const node = (file: string) => ({ errors: [{ type: 'value_not_in_list', extra_info: { input_name: 'vae_name', received_value: file } }], class_type: 'VAELoader' });
    expect((await errorFrom(refused({ error: {}, node_errors: { 1: node('a.safetensors'), 2: node('b.safetensors'), 3: node('a.safetensors') } })))?.message).toBe('Missing model a.safetensors. Missing model b.safetensors');
  });

  it('says what is wrong with a value that is not a file', async () => {
    const errors = [{ type: 'value_not_in_list', extra_info: { input_name: 'sampler_name', received_value: 'bogus' } }];
    expect((await errorFrom(refused({ error: {}, node_errors: { 1: { errors, class_type: 'KSampler' } } })))?.message).toBe('KSampler: "bogus" isn\'t a valid sampler_name');
  });

  it('says which input is missing', async () => {
    const errors = [{ type: 'required_input_missing', message: 'Required input is missing', details: 'latent_image', extra_info: { input_name: 'latent_image' } }];
    expect((await errorFrom(refused({ error: {}, node_errors: { 1: { errors, class_type: 'KSampler' } } })))?.message).toBe('KSampler is missing its latent_image input');
  });

  it('passes other node errors on, in one line', async () => {
    const errors = [{ type: 'value_bigger_than_max', message: 'Value 9 bigger than max of 4', details: 'steps\nmore', extra_info: {} }];
    expect((await errorFrom(refused({ error: {}, node_errors: { 1: { errors, class_type: 'KSampler' } } })))?.message).toBe('KSampler: Value 9 bigger than max of 4 (steps)');
  });

  it('says a node is missing', async () => {
    const body = { error: { type: 'missing_node_type', message: "Node 'FaceDetailer' not found. The custom node may not be installed.", details: "Node ID '#9'", extra_info: { node_id: '9', class_type: 'FaceDetailer', node_title: 'FaceDetailer' } }, node_errors: {} };
    expect((await errorFrom(refused(body)))?.message).toBe('ComfyUI has no FaceDetailer. Install it on the server, or update ComfyUI.');
  });

  it('passes on a job with nothing to make', async () => {
    const body = { error: { type: 'prompt_no_outputs', message: 'Prompt has no outputs', details: '', extra_info: {} }, node_errors: {} };
    expect((await errorFrom(refused(body)))?.message).toBe('ComfyUI refused the job: Prompt has no outputs');
  });

  it('falls back to what the server says', async () => {
    expect((await errorFrom(refused({ error: { type: 'other', message: 'Odd', details: 'very odd' }, node_errors: {} })))?.message).toBe('ComfyUI refused the job: very odd');
    expect((await errorFrom(refused({ error: 'plain text', node_errors: {} })))?.message).toBe('ComfyUI refused the job: plain text');
    expect((await errorFrom(refused({})))?.message).toBe('ComfyUI refused the job.');
  });

  it('copes with a proxy\'s error page', async () => {
    expect((await errorFrom({ promptResponse: () => new Response('<html>Bad gateway</html>', { status: 502 }) }))?.code).toBe('provider_busy');
  });

  it('keeps node errors from a job that ran but made nothing', async () => {
    const { adapter } = setup({
      promptResponse: (id) => jsonResponse({ prompt_id: id, number: 1, node_errors: VALUE_NOT_IN_LIST.node_errors }),
      onPrompt: (id, s) => s.socket.push(m.success(id)),
    });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).error?.message).toBe('Missing model foo.safetensors');
  });

  const failure = async (over: Record<string, unknown>) => {
    const { adapter } = setup({ onPrompt: (id, s) => s.socket.push(m.error(id, over)) });
    return finishOf(await collectEvents(adapter.generate(imageRequest()))).error;
  };

  it.each([
    ['a CUDA message', { exception_type: 'torch.cuda.OutOfMemoryError', exception_message: 'CUDA out of memory. Tried to allocate 2 GiB' }],
    ['an HIP message', { exception_type: 'RuntimeError', exception_message: 'HIP out of memory' }],
    ['an allocator message', { exception_type: 'RuntimeError', exception_message: 'Allocation on device 0 would exceed allowed memory' }],
  ])('says the GPU ran out of memory for %s, and what to do', async (_name, over) => {
    expect((await failure(over))?.message).toBe('The GPU on ComfyUI ran out of memory. Close other models that are using it, or ask for a smaller image or fewer at once.');
  });

  it('names a file that went missing while running', async () => {
    expect((await failure({ node_type: 'VAELoader', exception_type: 'FileNotFoundError', exception_message: 'No such file: ae.safetensors\nline two' }))?.message).toBe("VAELoader can't find a file on ComfyUI: No such file: ae.safetensors");
  });

  it('keeps anything else to its first line', async () => {
    expect((await failure({ exception_message: 'mat1 and mat2 shapes\ncannot be multiplied' }))?.message).toBe('KSampler failed on ComfyUI: mat1 and mat2 shapes');
    expect((await failure({ exception_message: 'x'.repeat(400) }))?.message.length).toBeLessThan(360);
    expect((await failure({ exception_message: '', exception_type: 'ValueError' }))?.message).toBe('KSampler failed on ComfyUI: ValueError');
  });

  it('never repeats a key', async () => {
    const { adapter } = setup({ instance: { ...instance, apiKey: 'sk-secret-key-12345' }, onPrompt: (id, s) => s.socket.push(m.error(id, { exception_message: 'bad sk-secret-key-12345' })) });
    expect(finishOf(await collectEvents(adapter.generate(imageRequest()))).error?.message).not.toContain('sk-secret');
  });
});

describe('input images', () => {
  const reference = { bytes: PNG, mime: 'image/png', name: 'input-img_ab12cd34.png' };
  const editRequest = (over: Partial<ImageRequest> = {}) => imageRequest({ references: [reference], ...over });

  it('uploads to temp, in its own folder, as bytes the plain-HTTP fetch can send', async () => {
    const { adapter, server } = setup({ onPrompt: happyJob });
    await collectEvents(adapter.generate(editRequest()));
    const upload = server.bodies.find((b) => b.url.endsWith('/upload/image'));
    expect(upload?.body).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder().decode(upload?.body as Uint8Array);
    expect(text).toContain('name="image"; filename="input-img_ab12cd34.png"');
    expect(text).toMatch(/name="type"\r\n\r\ntemp\r\n/);
    expect(text).toMatch(/name="subfolder"\r\n\r\natelier\r\n/);
    expect(text).toMatch(/name="overwrite"\r\n\r\ntrue\r\n/);
    expect(server.calls.find((c) => c.url.endsWith('/upload/image'))?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('loads it by the name that reads from temp', async () => {
    const { adapter, server } = setup({ onPrompt: happyJob });
    await collectEvents(adapter.generate(editRequest()));
    expect(nodesOf(sentGraph(server), 'LoadImage')[0]?.inputs.image).toBe('atelier/input-img_ab12cd34.png [temp]');
  });

  it('uploads a mask too', async () => {
    const { adapter, server } = setup({ onPrompt: happyJob });
    await collectEvents(adapter.generate(editRequest({ mask: { ...reference, name: 'mask.png' } })));
    expect(server.bodies.filter((b) => b.url.endsWith('/upload/image'))).toHaveLength(2);
    expect(nodesOf(sentGraph(server), 'LoadImageMask')).toHaveLength(1);
  });

  it('keeps the shape of the image it was given', async () => {
    const { adapter, server } = setup({ onPrompt: happyJob });
    await collectEvents(adapter.generate(editRequest()));
    expect(nodesOf(sentGraph(server), 'ImageScale')[0]?.inputs).toMatchObject({ width: 1024, height: 1024 });
  });

  it('fails plainly when the upload is refused', async () => {
    const { adapter, server } = setup({ routes: { 'POST /upload/image': () => new Response('disk full', { status: 500 }) } });
    expect(finishOf(await collectEvents(adapter.generate(editRequest()))).reason).toBe('error');
    expect(server.calls.some((c) => c.url.endsWith('/prompt'))).toBe(false);
  });

  it('fails plainly when the upload answer makes no sense', async () => {
    const { adapter } = setup({ routes: { 'POST /upload/image': () => jsonResponse({}) } });
    expect(finishOf(await collectEvents(adapter.generate(editRequest()))).error?.message).toContain("didn't say where it put");
  });
});

describe('saved workflows', () => {
  it('lists what the server has saved', async () => {
    const { adapter } = setup({ routes: { 'GET /userdata': () => jsonResponse([{ path: 'A.json', size: 10, modified: 5, created: 1 }, { path: 'sub/B.json' }, { nothing: true }]) } });
    expect(await adapter.savedWorkflows?.()).toEqual([{ path: 'A.json', size: 10, modified: 5 }, { path: 'sub/B.json' }]);
  });

  it('asks for the list with details, through subfolders', async () => {
    const { adapter, server } = setup({ routes: { 'GET /userdata': () => jsonResponse([]) } });
    await adapter.savedWorkflows?.();
    expect(server.calls[0]?.url).toBe(`${BASE}/userdata?dir=workflows&recurse=true&split=false&full_info=true`);
  });

  it('reads one by its path, encoded as one segment', async () => {
    const graph = (await import('./__fixtures__/comfy.ts')).fixture('api-z-image.json');
    const { adapter, server } = setup({ routes: { 'GET /userdata/workflows%2Fmy%20poster.json': () => new Response(JSON.stringify(graph)) } });
    const workflow = await adapter.parseWorkflow?.({ saved: 'my poster.json' });
    expect(workflow?.map.prompt).toEqual({ node: '5', input: 'text' });
    expect(server.calls[0]?.url).toBe(`${BASE}/userdata/workflows%2Fmy%20poster.json`);
  });

  it('reads the nodes a page-format workflow needs from this server, and only those', async () => {
    const workflow = (await import('./__fixtures__/comfy.ts')).fixture('frontend-image-to-image.json');
    const { adapter, server } = setup();
    const read = await adapter.parseWorkflow?.({ text: JSON.stringify(workflow) });
    expect(read?.map.image).toEqual({ node: '9', input: 'image' });
    expect(server.calls.every((c) => c.url.includes('/object_info/'))).toBe(true);
    expect(server.calls.length).toBeLessThan(10);
  });
});

describe('imported workflows as models', () => {
  const workflow = {
    id: 'wf-1',
    name: 'Mine',
    graph: {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      2: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'old' } },
      3: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['4', 0], seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
      4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
      5: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['1', 2] } },
      6: { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'mine' } },
    },
    map: { prompt: { node: '2', input: 'text' }, seed: { node: '3', input: 'seed' }, output: '6' },
  };

  it('runs one with the request\'s prompt and seed, keeping the result out of the output folder', async () => {
    const { adapter, server } = setup({ instance: { ...instance, workflows: [workflow] }, onPrompt: (id, s) => s.socket.push(m.executed(id, '6'), m.success(id)) });
    const events = await collectEvents(adapter.generate(imageRequest({ model: 'workflow:wf-1', seed: 9, prompt: 'new' })));
    expect(finishOf(events).reason).toBe('done');
    const graph = sentGraph(server);
    expect(graph['2']?.inputs.text).toBe('new');
    expect(graph['3']?.inputs.seed).toBe(9);
    expect(graph['6']).toEqual({ class_type: 'PreviewImage', inputs: { images: ['5', 0] } });
  });

  it('needs no reading of the server\'s nodes to run one', async () => {
    const { adapter, server } = setup({ instance: { ...instance, workflows: [workflow] }, onPrompt: (id, s) => s.socket.push(m.executed(id, '6'), m.success(id)) });
    await collectEvents(adapter.generate(imageRequest({ model: 'workflow:wf-1' })));
    expect(server.calls.some((c) => c.url.includes('/object_info'))).toBe(false);
  });

  it('takes the mapped output\'s images, not a preview along the way', async () => {
    const { adapter, server } = setup({
      instance: { ...instance, workflows: [workflow] },
      onPrompt: (id, s) => s.socket.push(m.executed(id, '99', [{ ...IMAGE, filename: 'preview.png' }]), m.executed(id, '6', [{ ...IMAGE, filename: 'final.png' }]), m.success(id)),
    });
    await collectEvents(adapter.generate(imageRequest({ model: 'workflow:wf-1' })));
    const views = server.calls.filter((c) => c.url.includes('/view'));
    expect(views).toHaveLength(1);
    expect(views[0]?.url).toContain('final.png');
  });

  it('takes whatever came out when no output is mapped', async () => {
    const { map: { output: _output, ...map }, ...rest } = workflow;
    const { adapter } = setup({ instance: { ...instance, workflows: [{ ...rest, map }] }, onPrompt: (id, s) => s.socket.push(m.executed(id, '6'), m.success(id)) });
    expect((await collectEvents(adapter.generate(imageRequest({ model: 'workflow:wf-1' })))).filter((e) => e.type === 'image')).toHaveLength(1);
  });

  it('says so when a workflow is gone', async () => {
    const { adapter } = setup();
    expect(finishOf(await collectEvents(adapter.generate(imageRequest({ model: 'workflow:nope' })))).error?.message).toContain('no workflow "nope"');
  });
});
