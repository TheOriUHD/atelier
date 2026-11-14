import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentHashInput, leadingZeroBits, powInput, ReportChat, ReportDiagnostics, reportTextProblem, type Message } from '@atelier/protocol';
import { buildChatExcerpt, cut } from './chat-excerpt.ts';
import { collectBackendDiagnostics, scrubError } from './collect.ts';
import { probeInference } from './inference.ts';
import { hostLabel, redactPrefs, redactValue, scrubSecrets } from './redact.ts';
import { reportScreenshot } from './screenshots.ts';
import { solveChallenge, submitReport } from './submit.ts';
import { parseLspci, parseNvidiaSmi, parseSystemProfiler, parseWindowsVideo } from './system.ts';

const WORDS = { home: '/Users/jane', words: ['jane', 'janes-macbook'] };

describe('what a report may say', () => {
  it('takes credentials out of any text, and the words that name this computer', () => {
    const text = [
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
      'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://user:hunter22@example.com/x?token=abc123&page=2',
      '{"password": "correct horse battery", "max_tokens": 4096}',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
      'opened /Users/jane/project/main.ts on janes-macbook as jane',
    ].join('\n');
    const out = scrubSecrets(text, WORDS);
    for (const secret of ['sk-proj-abc', 'abcdefghijklmnop1234', 'hunter22', 'token=abc123', 'correct horse', 'ghp_abc', 'b3BlbnNzaC1rZXk', '/Users/jane', 'janes-macbook', ' jane']) expect(out).not.toContain(secret);
    expect(out).toContain('"max_tokens": 4096');
    expect(out).toContain('page=2');
    expect(out).toContain('~/project/main.ts');
  });

  it('stays fast on long text that looks almost like a secret', () => {
    const inputs = ['a.'.repeat(500_000), 'x'.repeat(1_000_000), `${'token'.repeat(100_000)}=`, `${'a:'.repeat(300_000)}@`, `https://${'a'.repeat(500_000)}`, `?${'key'.repeat(100_000)}`];
    for (const input of inputs) {
      const started = performance.now();
      scrubSecrets(input, WORDS);
      scrubError(input.slice(0, 5000), WORDS);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });

  it('names public AI services but never a private address', () => {
    expect(hostLabel('http://localhost:11434')).toBe('localhost:11434');
    expect(hostLabel('http://127.0.0.1:8080/v1')).toBe('localhost:8080');
    expect(hostLabel('https://api.openai.com/v1')).toBe('api.openai.com');
    expect(hostLabel('https://my-resource.openai.azure.com')).toBe('my-resource.openai.azure.com');
    expect(hostLabel('http://192.168.1.20:11434')).toBe('private network');
    expect(hostLabel('http://100.101.102.103:11434')).toBe('private network');
    expect(hostLabel('http://gpu-box:11434')).toBe('private network');
    expect(hostLabel('https://llm.acme-corp.com')).toBe('other host');
  });

  it('leaves secrets, headers, addresses, paths and free text out of settings', () => {
    const settings = {
      providers: [{ id: 'p1', type: 'openai', baseUrl: 'https://llm.acme-corp.com/v1', apiKey: '${secret:abc}', headers: { Authorization: 'Bearer xyz123456789' }, enabled: true, vramGiB: 24 }],
      prompts: { organizationInstructions: 'Always answer in the voice of our CEO Jane.' },
      mcpServers: { tools: { command: '/opt/bin/mcp-server --token abc', args: ['--api-key', 'deadbeefdeadbeefdeadbeef', '--port=3000', '/Users/jane/x'], env: { GITHUB_TOKEN: 'ghp_x' } } },
      limits: { maxTokens: 8000 },
      permissions: { additionalDirectories: ['/Users/jane/Documents'] },
      capabilities: { webSearch: { apiKey: 'tvly-literal' } },
    };
    const out = JSON.stringify(redactValue(settings, WORDS));
    for (const secret of ['abc}', 'xyz123', 'acme-corp', 'CEO Jane', '/opt/bin', 'deadbeef', 'ghp_x', '/Users/jane', 'tvly-literal']) expect(out).not.toContain(secret);
    expect(out).toContain('<secret ref>');
    expect(out).toContain('"Authorization":"<redacted>"');
    expect(out).toContain('"maxTokens":8000');
    expect(out).toContain('"vramGiB":24');
    expect(out).toContain('mcp-server');
    expect(out).toContain('--port=3000');
    expect(out).toContain('"GITHUB_TOKEN":"<redacted>"');
  });

  it("leaves out the person's own words and identity from their preferences", () => {
    const out = JSON.stringify(redactPrefs({ callMe: 'Jane', personalization: { instructions: 'I live in Bremen' }, git: { authorEmail: 'jane@example.com' }, theme: 'dark', shortcuts: { search: 'Mod+K' } }, WORDS));
    expect(out).not.toMatch(/Jane|Bremen|example\.com/);
    expect(out).toContain('"theme":"dark"');
    expect(out).toContain('Mod+K');
  });

  it('tells a real description from padding', () => {
    expect(reportTextProblem('description', 'Chat doesnt work. AAAAAAAAAAAAAAAA')).toMatch(/repeated/);
    expect(reportTextProblem('description', 'broken')).toMatch(/more/);
    expect(reportTextProblem('description', 'bug bug bug bug bug bug bug bug')).not.toBeNull();
    expect(reportTextProblem('description', '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')).not.toBeNull();
    expect(reportTextProblem('description', 'The chat stops answering after I attach a PDF with 1000000 rows.')).toBeNull();
    expect(reportTextProblem('title', 'Chat broken')).toBeNull();
    expect(reportTextProblem('title', 'x')).not.toBeNull();
    expect(reportTextProblem('title', '   ')).toMatch(/title/);
  });
});

const msg = (i: number, role: Message['role'], parts: Message['parts'], extra: Partial<Message> = {}): Message => ({
  id: `m${i}`,
  sessionId: 's',
  parentId: i ? `m${i - 1}` : null,
  role,
  parts,
  model: role === 'assistant' ? 'ollama/qwen3:32b' : null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: 1_000 + i,
  ...extra,
});

const SESSION = { mode: 'code', title: 'Fix the build', status: 'idle', createdAt: 1, updatedAt: 2, model: 'ollama/qwen3:32b' };

describe('a chat in a report', () => {
  it('goes whole when it is small, with tool calls and results, and scrubbed', async () => {
    const messages = [
      msg(0, 'user', [{ type: 'text', text: 'Build it. My key is sk-ant-abcdefghijklmnopqrstu' }]),
      msg(1, 'assistant', [
        { type: 'thinking', text: 'Plan first.' },
        { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'cat /Users/jane/app/.env' } },
      ]),
      msg(2, 'tool', [{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'DB_PASSWORD=supersecret99' }], isError: false }]),
      msg(3, 'user', [{ type: 'context', text: '' }, { type: 'image', mime: 'image/png', blob: 'abc' }]),
    ];
    const chat = await buildChatExcerpt({ session: SESSION, messages, words: WORDS });
    expect(ReportChat.parse(chat)).toBeTruthy();
    expect(chat.coverage).toEqual({ total: 4, included: 4, omitted: [], shortened: 0 });
    const text = JSON.stringify(chat);
    expect(text).not.toMatch(/sk-ant|supersecret|\/Users\/jane/);
    expect(chat.messages[1]!.parts.map((p) => p.type)).toEqual(['thinking', 'tool_call']);
    // A state-only note is left out; a picture is only named.
    expect(chat.messages[3]!.parts).toEqual([{ type: 'image', mime: 'image/png' }]);
  });

  it('keeps the start and the newest messages of a long one, and says what is left out', async () => {
    const big = 'x'.repeat(30_000);
    const messages = Array.from({ length: 400 }, (_, i) => msg(i, i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `${i === 0 ? 'THE FIRST PROMPT ' : ''}message ${i} ${big}` }]));
    messages[200] = msg(200, 'user', [{ type: 'text', text: 'SUMMARY of what came before' }], { kind: 'compaction_summary' });
    const chat = await buildChatExcerpt({ session: SESSION, messages, budgetBytes: 1_000_000 });
    expect(Buffer.byteLength(JSON.stringify(chat))).toBeLessThan(1_050_000);
    expect(chat.messages[0]!.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('THE FIRST PROMPT') });
    expect(chat.messages.some((m) => m.kind === 'compaction_summary')).toBe(true);
    expect(chat.messages.at(-1)!.index).toBe(399);
    expect(chat.coverage.total).toBe(400);
    expect(chat.coverage.omitted.length).toBeGreaterThan(0);
    // Kept and left out add up.
    const omitted = chat.coverage.omitted.reduce((n, g) => n + g.to - g.from + 1, 0);
    expect(omitted + chat.coverage.included).toBe(400);
  });

  it('cuts a very long part in the middle and says how much', () => {
    const { text, cut: n } = cut('a'.repeat(100) + 'b'.repeat(100), 100);
    expect(text.startsWith('a'.repeat(70))).toBe(true);
    expect(text.endsWith('b'.repeat(30))).toBe(true);
    expect(n).toBe(100);
  });

  it("brings a sub-agent's last messages along", async () => {
    const messages = [msg(0, 'user', [{ type: 'text', text: 'Look around' }]), msg(1, 'assistant', [{ type: 'tool_call', id: 't', name: 'Task', input: {}, childSessionId: 'child' }])];
    const chat = await buildChatExcerpt({
      session: SESSION,
      messages,
      child: async (id) => (id === 'child' ? { title: 'Explore', mode: 'code', status: 'idle', messages: Array.from({ length: 10 }, (_, i) => msg(i, 'assistant', [{ type: 'text', text: `step ${i}` }])) } : null),
    });
    const call = chat.messages[1]!.parts[0]!;
    expect(call.type === 'tool_call' && call.child?.messageCount).toBe(10);
    expect(call.type === 'tool_call' && call.child?.messages.map((m) => m.index)).toEqual([4, 5, 6, 7, 8, 9]);
  });
});

describe('local model servers in a report', () => {
  it("asks Ollama what it has and what is loaded, and skips public services", async () => {
    const asked: string[] = [];
    const fetch = async (url: string) => {
      asked.push(url);
      const body = url.endsWith('/api/version')
        ? { version: '0.12.3' }
        : url.endsWith('/api/tags')
          ? { models: [{ name: 'qwen3:32b', size: 20e9, details: { quantization_level: 'Q4_K_M', family: 'qwen3', parameter_size: '32.8B' } }] }
          : { models: [{ name: 'qwen3:32b', size: 22e9, size_vram: 21e9, context_length: 32768, expires_at: '2026-11-14T20:00:00Z' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const found = await probeInference(fetch, [
      { type: 'ollama', baseUrl: 'http://localhost:11434' },
      { type: 'openai', baseUrl: 'https://api.openai.com' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'ollama', host: 'localhost:11434', version: '0.12.3', loaded: [{ name: 'qwen3:32b', vramBytes: 21e9, contextLength: 32768 }] });
    expect(found[0]!.models?.[0]).toMatchObject({ quantization: 'Q4_K_M', parameters: '32.8B' });
    expect(asked.every((u) => u.startsWith('http://localhost:11434'))).toBe(true);
  });

  it('reports a server that does not answer, without its address', async () => {
    const fetch = async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 192.168.1.5:11434') });
    };
    const [found] = await probeInference(fetch, [{ type: 'ollama', baseUrl: 'http://192.168.1.5:11434' }]);
    expect(found).toMatchObject({ kind: 'ollama', host: 'private network' });
    expect(found!.error).toContain('ECONNREFUSED <address>');
  });
});

describe('graphics cards', () => {
  it('reads nvidia-smi, system_profiler, WMI and lspci', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564, 20000, 581.57\n')).toEqual([{ name: 'NVIDIA GeForce RTX 4090', vendor: 'NVIDIA', vramBytes: 24564 * 1024 * 1024, vramFreeBytes: 20000 * 1024 * 1024, driver: '581.57', source: 'nvidia-smi' }]);
    expect(parseSystemProfiler(JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M4 Max', sppci_cores: '40', spdisplays_vendor: 'sppci_vendor_Apple' }] }))[0]).toMatchObject({ name: 'Apple M4 Max (40 cores)', vendor: 'Apple' });
    expect(parseWindowsVideo(JSON.stringify({ Name: 'AMD Radeon RX 7900 XTX', AdapterCompatibility: 'Advanced Micro Devices, Inc.', DriverVersion: '32.0.12011.1036', AdapterRAM: 4293918720 }))[0]).toMatchObject({ name: 'AMD Radeon RX 7900 XTX', source: 'wmi' });
    expect(parseLspci('01:00.0 "VGA compatible controller" "NVIDIA Corporation" "AD102 [GeForce RTX 4090]" -ra1 "ASUSTeK"\n00:02.0 "Host bridge" "Intel" "x"')[0]).toMatchObject({ name: 'NVIDIA Corporation AD102 [GeForce RTX 4090]' });
  });
});

describe('backend diagnostics', () => {
  it('fit the report format and say nothing secret', async () => {
    const diag = await collectBackendDiagnostics({
      kind: 'desktop',
      dataDir: process.cwd(),
      settings: { providers: [{ id: 'o', type: 'ollama', baseUrl: 'http://localhost:1', enabled: true }, { id: 'a', type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '${secret:x}', enabled: true }] },
      prefs: { callMe: 'Jane', theme: 'dark' },
      providerStatus: [{ providerId: 'a', ok: false, latencyMs: null, modelCount: 0, warnings: [], error: '401 from https://api.anthropic.com/v1/models key sk-ant-abcdefghijklmnopqrstuv', checkedAt: 1 }],
      models: (id) => (id === 'a' ? ['claude-x'] : []),
      connectors: [],
      counts: () => ({ sessions: 3 }),
      dataBytes: () => 1234,
      fetch: async () => new Response('nope', { status: 404 }),
      words: WORDS,
    });
    expect(ReportDiagnostics.parse(diag)).toBeTruthy();
    expect(diag.providers?.[1]).toMatchObject({ type: 'anthropic', host: 'api.anthropic.com', keySet: true, models: ['claude-x'], status: { ok: false } });
    expect(JSON.stringify(diag)).not.toMatch(/sk-ant|Jane/);
    expect(diag.backend?.hardware.memory?.totalBytes).toBeGreaterThan(0);
    expect(scrubError('ECONNREFUSED 10.0.0.4:443 https://secret.example.org/a?b=c', {})).toBe('ECONNREFUSED <address> https://other host');
  });
});

describe('sending', () => {
  it('does the proof of work the collector asks for and posts the parts in order', async () => {
    const seen: { url: string; headers: Record<string, string>; parts?: string[] }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
      if (url.endsWith('/v1/challenge')) {
        seen.push({ url, headers });
        return new Response(JSON.stringify({ challenge: 'c.10.x.y', bits: 10, expiresAt: Date.now() + 60_000 }), { status: 200 });
      }
      const form = init.body as FormData;
      const parts = [...form.keys()];
      seen.push({ url, headers, parts });
      // Check the proof as the collector does.
      const hashes = await Promise.all(parts.map(async (name) => ({ name, sha256: createHash('sha256').update(new Uint8Array(await (form.get(name) as Blob).arrayBuffer())).digest('hex') })));
      const contentHash = createHash('sha256').update(contentHashInput(hashes)).digest('hex');
      const hash = createHash('sha256').update(powInput(headers['x-atelier-challenge']!, contentHash, headers['x-atelier-nonce']!)).digest();
      return new Response(JSON.stringify(leadingZeroBits(hash) >= 10 ? { id: 'I-7F3K2Q', receivedAt: 1 } : { error: 'bad proof' }), { status: leadingZeroBits(hash) >= 10 ? 201 : 403 });
    };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const receipt = await submitReport(fetch, 'https://collector.test/', {
      envelope: { v: 1, kind: 'issue', title: 'It broke', description: 'It broke when I did the thing.', app: { version: '0.9.0', surface: 'desktop', mode: 'desktop-local' }, attachments: { chat: false, screenshots: [] }, createdAt: 1 },
      chat: null,
      screenshots: [{ name: 'shot0', mime: 'image/png', bytes: png }],
    });
    expect(receipt.id).toBe('I-7F3K2Q');
    expect(seen.map((s) => s.url)).toEqual(['https://collector.test/v1/challenge', 'https://collector.test/v1/reports']);
    expect(seen[1]!.parts).toEqual(['report', 'shot0']);
    expect(seen[0]!.headers['user-agent']).toMatch(/^Atelier\//);
  });

  it("says the collector's refusal as it is", async () => {
    const fetch = async () => new Response(JSON.stringify({ error: 'Too many reports from this address today.' }), { status: 429 });
    await expect(submitReport(fetch, 'https://c.test', { envelope: {} as never, chat: null, screenshots: [] })).rejects.toThrow('Too many reports from this address today.');
  });

  it('finds a nonce for the difficulty', async () => {
    const nonce = await solveChallenge('abc', 12, 'hash');
    expect(leadingZeroBits(createHash('sha256').update(powInput('abc', 'hash', nonce)).digest())).toBeGreaterThanOrEqual(12);
  });

  it('checks a screenshot is the picture it says it is', () => {
    expect(reportScreenshot('shot0', { mime: 'image/png', dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]).toString('base64'), width: 10, height: 10 })).toMatchObject({ mime: 'image/png' });
    expect(reportScreenshot('shot0', { mime: 'image/webp', dataBase64: Buffer.from('<svg></svg>').toString('base64'), width: 10, height: 10 })).toMatch(/not the picture/);
  });
});
