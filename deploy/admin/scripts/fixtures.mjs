/**
 * Fake reports for local development (seed.mjs): realistic, and valid against packages/protocol/src/reports.ts. Every
 * name, address and figure here is made up.
 */

const now = Date.now();
const ago = (ms) => now - ms;
const MIN = 60_000;
const HOUR = 60 * MIN;

// ------------------------------------------------------------------ 1: a Mac with Ollama, and a long Code chat

const macSystem = {
  os: {
    platform: 'darwin',
    name: 'macOS 26.1',
    release: '25.1.0',
    arch: 'arm64',
    locale: 'de-DE',
    timeZone: 'Europe/Berlin',
  },
  hardware: {
    model: 'Mac16,7',
    cpu: { model: 'Apple M4 Pro', cores: 14, speedMHz: 4512 },
    memory: { totalBytes: 51_539_607_552, freeBytes: 9_126_805_504 },
    gpus: [{ name: 'Apple M4 Pro', vendor: 'Apple', source: 'system_profiler' }],
    disk: { totalBytes: 994_662_584_320, freeBytes: 212_406_329_344 },
    displays: [
      { width: 3456, height: 2234, scale: 2, refreshHz: 120, primary: true },
      { width: 2560, height: 1440, scale: 1, refreshHz: 60 },
    ],
  },
  runtime: { electron: '44.7.1', chrome: '146.0.7680.80', node: '24.11.0' },
  uptimeSeconds: 412_380,
};

function macLog() {
  const t = (s) => new Date(ago(40 * MIN) + s * 1000).toISOString();
  const lines = [];
  for (let i = 0; i < 52; i++) {
    const kinds = [
      `${t(i * 20)} [info] backend: session 9c2e… turn ${i + 1} started (code, qwen3:30b-a3b)`,
      `${t(i * 20 + 3)} [info] ollama: POST /api/chat 200 in ${(800 + ((i * 137) % 2400)).toLocaleString('en')} ms`,
      `${t(i * 20 + 9)} [info] code: tool Bash finished in ${(120 + ((i * 53) % 900)).toLocaleString('en')} ms`,
      `${t(i * 20 + 12)} [debug] updates: checked stable/latest-mac.yml, nothing newer`,
    ];
    lines.push(kinds[i % kinds.length]);
  }
  lines.push(`${t(1060)} [warn] code: tool Bash still running after 300 s (pnpm test)`);
  lines.push(`${t(1360)} [error] code: tool Bash failed: TimeoutError: The operation was aborted due to timeout`);
  lines.push(`${t(1361)} [error]     at runTool (packages/core/src/code/tools.ts:412:11)`);
  lines.push(`${t(1362)} [info] backend: session 9c2e… turn ended with error (provider stopped answering)`);
  lines.push(`${t(1500)} [info] reports: collecting diagnostics`);
  return lines;
}

const toolText = (lines) => lines.join('\n');

function codeChat() {
  const created = ago(3 * HOUR);
  let at = created;
  const next = (s = 40) => (at += s * 1000);
  const usage = (i) => ({ input: 18_000 + i * 410, output: 300 + ((i * 97) % 900), cacheRead: 14_000 + i * 380 });
  const messages = [
    {
      index: 0,
      role: 'user',
      kind: 'text',
      createdAt: next(0),
      parts: [
        {
          type: 'text',
          text: 'The tests in packages/api are flaky since yesterday. Find out why and fix it, please. The CI log is attached.',
        },
        { type: 'document', mime: 'text/plain', name: 'ci-log-4121.txt' },
      ],
    },
    {
      index: 1,
      role: 'assistant',
      kind: 'text',
      createdAt: next(),
      model: 'qwen3:30b-a3b',
      stopReason: 'tool_use',
      usage: usage(1),
      parts: [
        {
          type: 'thinking',
          text: 'The log shows schedule.test.ts failing on "next watering is tomorrow". Flaky date tests usually mean the test reads the real clock. Run the suite first to see it locally.',
        },
        { type: 'text', text: "I'll run the API package's tests first to see the failure here." },
        {
          type: 'tool_call',
          id: 'call_01',
          name: 'Bash',
          input: JSON.stringify({ command: 'pnpm --filter api test', description: 'Run the API tests' }),
        },
      ],
    },
    {
      index: 2,
      role: 'tool',
      kind: 'tool_result',
      createdAt: next(18),
      parts: [
        {
          type: 'tool_result',
          callId: 'call_01',
          cut: 11_482,
          text: toolText([
            ' RUN  v5.0.4 /Users/dev/garden-planner/packages/api',
            '',
            ' ✓ src/plants.test.ts (14 tests) 38ms',
            ' ✓ src/beds.test.ts (9 tests) 21ms',
            ' ❯ src/schedule.test.ts (12 tests | 1 failed) 44ms',
            '   × next watering > is tomorrow for a plant watered today',
            "     → expected '2026-11-15' to be '2026-11-14'",
            '',
            ' Test Files  1 failed | 2 passed (3)',
            '      Tests  1 failed | 34 passed (35)',
          ]),
        },
      ],
    },
    {
      index: 3,
      role: 'assistant',
      kind: 'text',
      createdAt: next(),
      model: 'qwen3:30b-a3b',
      stopReason: 'tool_use',
      usage: usage(3),
      parts: [
        {
          type: 'tool_call',
          id: 'call_02',
          name: 'Read',
          input: JSON.stringify({ file_path: 'packages/api/src/schedule.test.ts' }),
        },
      ],
    },
    {
      index: 4,
      role: 'tool',
      kind: 'tool_result',
      createdAt: next(1),
      parts: [
        {
          type: 'tool_result',
          callId: 'call_02',
          text: toolText([
            "import { describe, expect, it } from 'vitest';",
            "import { nextWatering } from './schedule';",
            '',
            "describe('next watering', () => {",
            "  it('is tomorrow for a plant watered today', () => {",
            '    const today = new Date();',
            "    const plant = { name: 'Basil', everyDays: 1, wateredAt: today };",
            '    const tomorrow = new Date(today.getTime() + 86_400_000);',
            '    expect(nextWatering(plant)).toBe(tomorrow.toISOString().slice(0, 10));',
            '  });',
            '});',
          ]),
        },
      ],
    },
    {
      index: 5,
      role: 'assistant',
      kind: 'text',
      createdAt: next(),
      model: 'qwen3:30b-a3b',
      stopReason: 'tool_use',
      usage: usage(5),
      parts: [
        {
          type: 'text',
          text: 'The test builds "tomorrow" from the real clock in **UTC**, while `nextWatering` works in local time. Between midnight and 1 a.m. in Berlin the two disagree. Let me check where else the clock is read.',
        },
        {
          type: 'tool_call',
          id: 'call_03',
          name: 'Grep',
          input: JSON.stringify({
            pattern: 'new Date\\(\\)|Date\\.now\\(\\)',
            path: 'packages/api/src',
            output_mode: 'content',
          }),
        },
      ],
    },
    {
      index: 6,
      role: 'tool',
      kind: 'tool_result',
      createdAt: next(1),
      parts: [
        {
          type: 'tool_result',
          callId: 'call_03',
          text: 'packages/api/src/schedule.ts:7:  const now = new Date();\npackages/api/src/schedule.test.ts:6:    const today = new Date();\npackages/api/src/reminders.ts:31:  if (Date.now() > plant.snoozedUntil) {',
        },
      ],
    },
    {
      index: 7,
      role: 'assistant',
      kind: 'text',
      createdAt: next(),
      model: 'qwen3:30b-a3b',
      stopReason: 'tool_use',
      usage: usage(7),
      parts: [
        { type: 'text', text: "I'll have a sub-agent look up when CI started failing, while I prepare the fix." },
        {
          type: 'tool_call',
          id: 'call_04',
          name: 'Agent',
          input: JSON.stringify({
            description: 'Find the first failing CI run',
            prompt:
              'Use gh to find the first run of the "test" workflow on main where packages/api failed, and what changed in it.',
          }),
          child: {
            title: 'Find the first failing CI run',
            mode: 'code',
            status: 'completed',
            messageCount: 14,
            messages: [
              {
                index: 0,
                role: 'user',
                kind: 'text',
                createdAt: next(1),
                parts: [
                  {
                    type: 'text',
                    text: 'Use gh to find the first run of the "test" workflow on main where packages/api failed, and what changed in it.',
                  },
                ],
              },
              {
                index: 11,
                role: 'assistant',
                kind: 'text',
                createdAt: next(20),
                model: 'qwen3:8b',
                parts: [
                  {
                    type: 'tool_call',
                    id: 'sub_07',
                    name: 'Bash',
                    input: JSON.stringify({
                      command:
                        'gh run list --workflow test --branch main --limit 20 --json databaseId,conclusion,headSha,createdAt',
                    }),
                  },
                ],
              },
              {
                index: 12,
                role: 'tool',
                kind: 'tool_result',
                createdAt: next(2),
                parts: [
                  {
                    type: 'tool_result',
                    callId: 'sub_07',
                    text: '[{"databaseId":4121,"conclusion":"failure","headSha":"9f3c2e1","createdAt":"2026-11-13T23:41:07Z"},{"databaseId":4118,"conclusion":"success","headSha":"b81d0aa","createdAt":"2026-11-13T17:02:55Z"}]',
                  },
                ],
              },
              {
                index: 13,
                role: 'assistant',
                kind: 'text',
                createdAt: next(10),
                model: 'qwen3:8b',
                stopReason: 'end_turn',
                parts: [
                  {
                    type: 'text',
                    text: 'Run **#4121** (9f3c2e1, 23:41 UTC) is the first failure. It changed nothing in `packages/api`; it ran at 00:41 Berlin time, when UTC and local dates differ.',
                  },
                ],
              },
            ],
          },
        },
      ],
    },
    {
      index: 8,
      role: 'tool',
      kind: 'tool_result',
      createdAt: next(2),
      parts: [
        {
          type: 'tool_result',
          callId: 'call_04',
          text: 'Run #4121 (9f3c2e1, 23:41 UTC) is the first failure. It changed nothing in packages/api; it ran at 00:41 Berlin time.',
        },
      ],
    },
    {
      index: 9,
      role: 'assistant',
      kind: 'text',
      createdAt: next(),
      model: 'qwen3:30b-a3b',
      stopReason: 'tool_use',
      usage: usage(9),
      parts: [
        {
          type: 'text',
          text: 'That confirms it: the test only fails in the hour after midnight. The fix is to give `nextWatering` the clock, and to fix it in the test:',
        },
        {
          type: 'tool_call',
          id: 'call_05',
          name: 'Edit',
          input: JSON.stringify({
            file_path: 'packages/api/src/schedule.ts',
            old_string: 'export function nextWatering(plant) {\n  const now = new Date();',
            new_string: 'export function nextWatering(plant, now = new Date()) {',
          }),
        },
      ],
    },
    {
      index: 10,
      role: 'tool',
      kind: 'tool_result',
      createdAt: next(1),
      parts: [
        { type: 'tool_result', callId: 'call_05', text: 'The file packages/api/src/schedule.ts has been updated.' },
      ],
    },
    {
      index: 11,
      role: 'user',
      kind: 'text',
      createdAt: next(120),
      parts: [
        {
          type: 'text',
          text: 'Looks good. Also check the time zone on CI, here is what I see in the Actions settings:',
        },
        { type: 'image', mime: 'image/png' },
      ],
    },
    // 12–840 left out by the app.
    {
      index: 841,
      role: 'assistant',
      kind: 'text',
      createdAt: next(3600),
      parts: [
        {
          type: 'context',
          text: 'Earlier messages were compacted into a summary: the clock is now passed in everywhere, CI runs with TZ=Europe/Berlin and TZ=UTC, 4 files changed.',
        },
      ],
    },
    {
      index: 842,
      role: 'user',
      kind: 'text',
      createdAt: next(60),
      parts: [{ type: 'text', text: 'Run the full suite once more, then open a PR.' }],
    },
    {
      index: 843,
      role: 'assistant',
      kind: 'text',
      createdAt: next(),
      model: 'qwen3:30b-a3b',
      stopReason: 'tool_use',
      usage: usage(843),
      parts: [
        {
          type: 'tool_call',
          id: 'call_412',
          name: 'Bash',
          input: JSON.stringify({ command: 'pnpm test', timeout: 600000 }),
        },
      ],
    },
    {
      index: 844,
      role: 'tool',
      kind: 'tool_result',
      createdAt: next(600),
      parts: [
        {
          type: 'tool_result',
          callId: 'call_412',
          isError: true,
          text: 'Command timed out after 600000 ms.\nThe last output was:\n  packages/web: building…',
        },
      ],
    },
  ];
  // A stretch of reading and editing, as the end of a long session looks.
  for (let i = 845; i < 861; i += 2) {
    const file = [
      'packages/web/vite.config.ts',
      'packages/web/src/main.ts',
      'packages/api/src/reminders.ts',
      'turbo.json',
    ][((i - 845) / 2) % 4];
    messages.push({
      index: i,
      role: 'assistant',
      kind: 'text',
      createdAt: next(),
      model: 'qwen3:30b-a3b',
      stopReason: 'tool_use',
      usage: usage(i),
      parts: [
        ...(i === 845
          ? [{ type: 'text', text: 'The web build hangs, not the tests. Looking at what it waits for.' }]
          : []),
        { type: 'tool_call', id: `call_${i}`, name: 'Read', input: JSON.stringify({ file_path: file }) },
      ],
    });
    messages.push({
      index: i + 1,
      role: 'tool',
      kind: 'tool_result',
      createdAt: next(1),
      parts: [
        {
          type: 'tool_result',
          callId: `call_${i}`,
          cut: i === 849 ? 3_204 : undefined,
          text: `// ${file}\nexport default {\n  // …\n};`,
        },
      ],
    });
  }
  messages.push({
    index: 861,
    role: 'assistant',
    kind: 'text',
    createdAt: next(),
    model: 'qwen3:30b-a3b',
    error: 'The provider stopped answering (Ollama closed the connection after 300 s).',
    parts: [{ type: 'thinking', text: 'The vite build waits on a watcher that never ends in CI mode', cut: 2_410 }],
  });
  for (const m of messages) for (const p of m.parts) if (p.cut === undefined) delete p.cut;
  return {
    session: {
      mode: 'code',
      title: 'Fix the flaky schedule tests',
      model: 'qwen3:30b-a3b',
      provider: 'ollama',
      effort: 'high',
      permissionMode: 'acceptEdits',
      status: 'error',
      createdAt: created,
      updatedAt: at,
      workspace: { name: 'garden-planner', kind: 'local' },
      todos: [
        { content: 'Reproduce the flaky schedule test', status: 'completed' },
        { content: 'Pass the clock into nextWatering', status: 'completed' },
        { content: 'Run CI in two time zones', status: 'completed' },
        { content: 'Run the full suite', status: 'in_progress' },
        { content: 'Open a pull request', status: 'pending' },
      ],
      usage: { input: 1_284_330, output: 61_204, cacheRead: 1_002_918 },
    },
    coverage: { total: 862, included: messages.length, omitted: [{ from: 12, to: 840 }], shortened: 4 },
    messages,
  };
}

const mac = {
  shots: [
    { name: 'shot0', kind: 'session' },
    { name: 'shot1', kind: 'error' },
  ],
  ip: 1,
  receivedAgo: 2 * HOUR,
  envelope: {
    v: 1,
    kind: 'issue',
    title: 'Code session stops after a long tool call times out',
    description:
      'I asked the Code session to run the full test suite of my project. The command ran into the 10 minute timeout, and after that the session just stopped: the assistant started thinking, then the error "The provider stopped answering" showed up and nothing I type gets an answer any more.\n\nRestarting Atelier helps, but the session stays in the error state. I expected the timeout to be reported and the session to go on. This happens every time with qwen3:30b-a3b on Ollama, not with Claude.',
    contact: 'jana.example@example.com',
    app: {
      version: '0.8.2',
      channel: 'stable',
      packaged: true,
      surface: 'desktop',
      mode: 'desktop-local',
      window: { width: 1512, height: 945, ratio: 2 },
      theme: 'dark',
      language: 'de',
    },
    diagnostics: {
      collectedAt: ago(2 * HOUR),
      client: macSystem,
      backend: {
        kind: 'desktop',
        os: macSystem.os,
        hardware: { cpu: macSystem.hardware.cpu, memory: macSystem.hardware.memory, disk: macSystem.hardware.disk },
        runtime: { node: '24.11.0' },
        dataBytes: 412_337_152,
        blobBytes: 2_104_221_696,
        counts: { sessions: 214, messages: 18_342, projects: 9, artifacts: 61 },
      },
      settings: {
        defaultModel: 'qwen3:30b-a3b',
        smallModel: 'qwen3:8b',
        providers: [
          { id: 'ollama', type: 'ollama', baseUrl: '<local address>', apiKey: '' },
          { id: 'anthropic', type: 'anthropic', apiKey: '<redacted>' },
          { id: 'openai', type: 'openai', apiKey: '<redacted>', enabled: false },
        ],
        code: { permissionMode: 'acceptEdits', sandbox: true, toolTimeoutSeconds: 600, autoCompact: true },
        capabilities: { webSearch: { enabled: true, provider: 'duckduckgo' }, webFetch: true, computerUse: true },
        updates: { channel: 'stable', automatic: true },
      },
      prefs: {
        theme: 'system',
        chatFont: 'serif',
        textSize: 'm',
        transcriptWidth: 'medium',
        sidebar: { collapsed: false, pinned: 4 },
        shortcuts: { newChat: 'Mod+N', palette: 'Mod+K' },
      },
      providers: [
        {
          type: 'ollama',
          host: 'localhost:11434',
          enabled: true,
          keySet: false,
          models: ['qwen3:30b-a3b', 'qwen3:8b', 'qwen3-coder:30b', 'gemma3:27b', 'nomic-embed-text:latest'],
          status: { ok: true, version: '0.13.2', latencyMs: 4, modelCount: 5 },
        },
        {
          type: 'anthropic',
          host: 'api.anthropic.com',
          enabled: true,
          keySet: true,
          models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
          status: { ok: true, latencyMs: 212, modelCount: 9 },
        },
        { type: 'openai', host: 'api.openai.com', enabled: false, keySet: true },
      ],
      imageProviders: [{ type: 'openai', host: 'api.openai.com', enabled: false, keySet: true }],
      inference: [
        {
          kind: 'ollama',
          host: 'localhost:11434',
          version: '0.13.2',
          models: [
            {
              name: 'qwen3:30b-a3b',
              sizeBytes: 18_556_699_802,
              quantization: 'Q4_K_M',
              family: 'qwen3moe',
              parameters: '30.5B',
            },
            {
              name: 'qwen3-coder:30b',
              sizeBytes: 18_556_700_811,
              quantization: 'Q4_K_M',
              family: 'qwen3moe',
              parameters: '30.5B',
            },
            { name: 'qwen3:8b', sizeBytes: 5_225_387_923, quantization: 'Q4_K_M', family: 'qwen3', parameters: '8.2B' },
            {
              name: 'gemma3:27b',
              sizeBytes: 17_396_936_941,
              quantization: 'Q4_K_M',
              family: 'gemma3',
              parameters: '27.4B',
            },
            {
              name: 'nomic-embed-text:latest',
              sizeBytes: 274_302_450,
              quantization: 'F16',
              family: 'nomic-bert',
              parameters: '137M',
            },
          ],
          loaded: [
            {
              name: 'qwen3:30b-a3b',
              sizeBytes: 21_441_380_352,
              vramBytes: 21_441_380_352,
              quantization: 'Q4_K_M',
              parameters: '30.5B',
              contextLength: 32_768,
              expiresAt: new Date(now + 4 * MIN).toISOString(),
            },
            {
              name: 'nomic-embed-text:latest',
              sizeBytes: 621_203_456,
              vramBytes: 621_203_456,
              contextLength: 2048,
              expiresAt: new Date(now + 2 * MIN).toISOString(),
            },
          ],
          devices: [{ name: 'Apple M4 Pro', type: 'Metal', vramBytes: 38_654_705_664, vramFreeBytes: 16_592_121_856 }],
        },
      ],
      connectors: [
        { type: 'github', status: 'connected', tools: 34 },
        { type: 'filesystem', status: 'connected', tools: 11 },
        { type: 'linear', status: 'error', error: 'The server answered 401 Unauthorized: sign in again.' },
      ],
      computerUse: {
        available: true,
        enabled: true,
        helper: 'atelier-computer 0.8.2',
        notes: { accessibility: 'granted', 'screen recording': 'granted' },
      },
      log: macLog(),
      lastError: {
        message:
          'TimeoutError: The operation was aborted due to timeout\n    at runTool (packages/core/src/code/tools.ts:412:11)',
        at: ago(2 * HOUR + 12 * MIN),
      },
      notes: { 'update channel': 'stable', 'gpu acceleration': 'on', 'code sandbox': 'seatbelt' },
    },
    createdAt: ago(2 * HOUR),
  },
  chat: codeChat(),
};

// ------------------------------------------------------------------ 2: Windows with an RTX 4090 and ComfyUI

const winSystem = {
  os: {
    platform: 'win32',
    name: 'Windows 11 Pro 24H2',
    release: '10.0.26100',
    arch: 'x64',
    locale: 'en-US',
    timeZone: 'America/Chicago',
  },
  hardware: {
    model: 'MS-7E12',
    cpu: { model: 'AMD Ryzen 9 7950X 16-Core Processor', cores: 32, speedMHz: 4501 },
    memory: { totalBytes: 68_719_476_736, freeBytes: 31_084_216_320 },
    gpus: [
      {
        name: 'NVIDIA GeForce RTX 4090',
        vendor: 'NVIDIA',
        driver: '581.57',
        vramBytes: 25_757_220_864,
        vramFreeBytes: 1_181_745_152,
        source: 'nvidia-smi',
      },
      {
        name: 'AMD Radeon(TM) Graphics',
        vendor: 'AMD',
        driver: '32.0.12011.1036',
        vramBytes: 536_870_912,
        source: 'wmi',
      },
    ],
    disk: { totalBytes: 2_000_263_573_504, freeBytes: 187_903_098_880 },
    displays: [{ width: 3840, height: 2160, scale: 1.5, refreshHz: 144, primary: true }],
  },
  runtime: { electron: '44.7.1', chrome: '146.0.7680.80', node: '24.11.0' },
  uptimeSeconds: 93_211,
};

const windows = {
  shots: [{ name: 'shot0', kind: 'images' }],
  ip: 2,
  receivedAgo: 5 * HOUR,
  envelope: {
    v: 1,
    kind: 'issue',
    title: 'Image generation with ComfyUI fails after the first picture',
    description:
      'The first picture from my ComfyUI workflow (Flux dev, 1024×1024) comes out fine. The second one in the same chat fails with "ComfyUI ran out of GPU memory", although nothing else uses the GPU. ComfyUI itself keeps working when I queue the same prompt in its own page. It looks like the model stays loaded and a second copy is loaded next to it.',
    app: {
      version: '0.8.2',
      channel: 'stable',
      packaged: true,
      surface: 'desktop',
      mode: 'desktop-local',
      window: { width: 2560, height: 1392, ratio: 1.5 },
      theme: 'light',
      language: 'en',
    },
    diagnostics: {
      collectedAt: ago(5 * HOUR),
      client: winSystem,
      backend: {
        kind: 'desktop',
        os: winSystem.os,
        hardware: {
          cpu: winSystem.hardware.cpu,
          memory: winSystem.hardware.memory,
          gpus: winSystem.hardware.gpus.slice(0, 1),
        },
        runtime: { node: '24.11.0' },
        dataBytes: 98_112_512,
        blobBytes: 4_812_008_448,
        counts: { sessions: 41, messages: 1_920, images: 388 },
      },
      settings: {
        defaultModel: 'gpt-5.1',
        images: { provider: 'comfyui', workflow: 'flux-dev-1024', steps: 28 },
        providers: [
          { id: 'openai', type: 'openai', apiKey: '<redacted>' },
          { id: 'llama', type: 'llama.cpp', baseUrl: '<local address>' },
        ],
      },
      prefs: { theme: 'light', textSize: 'l' },
      providers: [
        {
          type: 'openai',
          host: 'api.openai.com',
          enabled: true,
          keySet: true,
          models: ['gpt-5.1', 'gpt-5.1-mini'],
          status: { ok: true, latencyMs: 188, modelCount: 42 },
        },
        {
          type: 'llama.cpp',
          host: 'localhost:8080',
          enabled: true,
          keySet: false,
          models: ['gpt-oss-20b'],
          status: { ok: true, version: 'b7012', latencyMs: 2 },
        },
      ],
      imageProviders: [
        {
          type: 'comfyui',
          host: 'localhost:8188',
          enabled: true,
          keySet: false,
          models: ['flux1-dev-fp8.safetensors', 'sdxl_base_1.0.safetensors'],
          status: { ok: true, version: '0.3.68', latencyMs: 6 },
        },
      ],
      inference: [
        {
          kind: 'comfyui',
          host: 'localhost:8188',
          version: '0.3.68',
          devices: [
            {
              name: 'cuda:0 NVIDIA GeForce RTX 4090',
              type: 'cuda',
              vramBytes: 25_757_220_864,
              vramFreeBytes: 1_181_745_152,
            },
          ],
          models: [
            { name: 'flux1-dev-fp8.safetensors', sizeBytes: 17_246_524_772 },
            { name: 'sdxl_base_1.0.safetensors', sizeBytes: 6_938_078_334 },
          ],
          notes: { python: '3.12.10', pytorch: '2.9.1+cu130', 'queue remaining': '0' },
        },
        {
          kind: 'llama.cpp',
          host: 'localhost:8080',
          version: 'b7012',
          loaded: [
            {
              name: 'gpt-oss-20b-mxfp4.gguf',
              sizeBytes: 12_109_565_952,
              vramBytes: 13_103_005_696,
              contextLength: 65_536,
            },
          ],
          slots: 4,
        },
      ],
      connectors: [{ type: 'filesystem', status: 'connected', tools: 11 }],
      computerUse: { available: false, notes: { reason: 'Windows: not yet supported' } },
      log: [
        '2026-11-14T09:12:01.112Z [info] images: comfyui prompt 7f1c queued (flux-dev-1024)',
        '2026-11-14T09:12:19.870Z [info] images: comfyui prompt 7f1c done in 18.7 s',
        '2026-11-14T09:13:40.002Z [info] images: comfyui prompt 81aa queued (flux-dev-1024)',
        '2026-11-14T09:13:44.517Z [error] images: comfyui prompt 81aa failed: torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 72.00 MiB. GPU 0 has a total capacity of 23.99 GiB of which 0 bytes is free.',
        '2026-11-14T09:13:44.519Z [info] images: told the person "ComfyUI ran out of GPU memory"',
      ],
      lastError: {
        message: 'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 72.00 MiB.',
        at: ago(5 * HOUR + 3 * MIN),
      },
      notes: { 'update channel': 'stable' },
    },
    attachments: { chat: false, screenshots: [] },
    createdAt: ago(5 * HOUR),
  },
};

// ------------------------------------------------------------------ 3: a Linux server, used from a browser

const serverSystem = {
  kind: 'server',
  os: {
    platform: 'linux',
    name: 'Ubuntu 24.04.3 LTS',
    release: '6.8.0-87-generic',
    arch: 'x64',
    locale: 'C.UTF-8',
    timeZone: 'UTC',
  },
  hardware: {
    model: 'KVM',
    cpu: { model: 'AMD EPYC 7763 64-Core Processor', cores: 16, speedMHz: 2445 },
    memory: { totalBytes: 67_430_719_488, freeBytes: 22_910_828_544 },
    gpus: [
      {
        name: 'NVIDIA L4',
        vendor: 'NVIDIA',
        driver: '580.95.05',
        vramBytes: 24_152_899_584,
        vramFreeBytes: 2_002_780_160,
        source: 'nvidia-smi',
      },
    ],
    disk: { totalBytes: 1_967_317_549_056, freeBytes: 1_402_175_291_392 },
  },
  runtime: { node: '24.11.0' },
  container: true,
  uptimeSeconds: 3_550_112,
  dataBytes: 3_221_225_472,
  blobBytes: 61_203_283_968,
  counts: { users: 14, sessions: 2_903, messages: 211_044, projects: 120 },
};

const server = {
  shots: [{ name: 'shot0', kind: 'upload' }],
  ip: 3,
  receivedAgo: 26 * HOUR,
  status: 'triaged',
  labels: ['uploads', 'server'],
  note: 'Probably the proxy body limit in their Caddy, see the 0.8.1 server version. Ask for the Caddyfile.',
  seen: true,
  envelope: {
    v: 1,
    kind: 'issue',
    title: 'Uploading a large PDF to a project hangs at 99 percent',
    description:
      'On our team server, adding a 180 MB PDF to a project shows the progress bar up to 99 % and then nothing happens, also after waiting 20 minutes. Smaller files work. The server runs in Docker with the compose file from the docs, behind Caddy.',
    contact: 'it-team@example.org',
    app: {
      version: '0.8.2',
      channel: 'stable',
      surface: 'web',
      mode: 'web',
      serverVersion: '0.8.1',
      window: { width: 1920, height: 961, ratio: 1 },
      theme: 'light',
      language: 'en',
    },
    diagnostics: {
      collectedAt: ago(26 * HOUR),
      client: {
        os: { platform: 'win32', name: 'Windows 11', arch: 'x64', locale: 'en-GB', timeZone: 'Europe/London' },
        hardware: { displays: [{ width: 1920, height: 1080, scale: 1 }] },
        runtime: { browser: 'Firefox 145.0' },
      },
      backend: serverSystem,
      settings: {
        storage: { maxUploadMb: 250 },
        auth: { method: 'oidc', issuer: '<address>' },
        providers: [{ id: 'vllm', type: 'openai-compatible', baseUrl: '<private network>' }],
      },
      providers: [
        {
          type: 'openai-compatible',
          host: 'private network',
          enabled: true,
          keySet: true,
          models: ['Qwen/Qwen3-32B-AWQ'],
          status: { ok: true, latencyMs: 31, modelCount: 1 },
        },
        {
          type: 'openrouter',
          host: 'openrouter.ai',
          enabled: true,
          keySet: true,
          status: { ok: false, error: 'The key has no credits left (402).' },
        },
      ],
      inference: [
        {
          kind: 'vllm',
          host: 'private network',
          version: '0.11.2',
          loaded: [
            {
              name: 'Qwen/Qwen3-32B-AWQ',
              vramBytes: 19_327_352_832,
              contextLength: 40_960,
              quantization: 'AWQ',
              parameters: '32B',
            },
          ],
          devices: [{ name: 'NVIDIA L4', type: 'cuda', vramBytes: 24_152_899_584, vramFreeBytes: 2_002_780_160 }],
        },
      ],
      log: [
        '2026-11-13T10:02:11.004Z [info] blobs: upload 5d1e started (180.2 MB, application/pdf)',
        '2026-11-13T10:03:58.310Z [warn] blobs: upload 5d1e: client went away after 179.9 MB',
        '2026-11-13T10:03:58.311Z [error] blobs: upload 5d1e aborted: Error: aborted',
      ],
      lastError: { message: 'Error: aborted', at: ago(26 * HOUR + 5 * MIN) },
      notes: { proxy: 'X-Forwarded-For present' },
    },
    attachments: { chat: true, screenshots: [] },
    createdAt: ago(26 * HOUR),
  },
  chat: {
    session: {
      mode: 'chat',
      title: 'Summarise the grant guidelines',
      model: 'Qwen/Qwen3-32B-AWQ',
      provider: 'openai-compatible',
      status: 'idle',
      createdAt: ago(27 * HOUR),
      updatedAt: ago(26 * HOUR),
      workspace: { name: 'Grants 2027', kind: 'scratch' },
    },
    coverage: { total: 3, included: 3, omitted: [], shortened: 0 },
    messages: [
      {
        index: 0,
        role: 'user',
        kind: 'text',
        createdAt: ago(27 * HOUR),
        author: 'Sam',
        parts: [
          { type: 'text', text: 'Summarise the attached guidelines in five bullet points.' },
          { type: 'document', mime: 'application/pdf', name: 'guidelines-2027.pdf' },
        ],
      },
      {
        index: 1,
        role: 'assistant',
        kind: 'text',
        createdAt: ago(27 * HOUR - MIN),
        model: 'Qwen/Qwen3-32B-AWQ',
        stopReason: 'stop',
        usage: { input: 1840, output: 212 },
        parts: [
          {
            type: 'text',
            text: "I can't see the document's text yet: the upload didn't finish. Could you attach it again, or paste the part you need?\n\n<script>alert('this is shown as text, not run')</script>",
          },
        ],
      },
      {
        index: 2,
        role: 'user',
        kind: 'text',
        createdAt: ago(26 * HOUR),
        author: 'Sam',
        parts: [{ type: 'text', text: 'It keeps stopping at 99 %.' }],
      },
    ],
  },
};

// ------------------------------------------------------------------ 4–8: the rest of an inbox

const featureNoDiagnostics = {
  ip: 4,
  receivedAgo: 50 * MIN,
  envelope: {
    v: 1,
    kind: 'feature',
    title: 'Pin chats to the top of the sidebar',
    description:
      'I keep three long-running chats open all week (one per client). It would help a lot to pin them above the rest of the sidebar, so they stay at the top no matter what else I start. A right-click "Pin" would be perfect.',
    contact: '@gardener on Mastodon',
    app: { version: '0.8.2', channel: 'stable', surface: 'desktop', mode: 'desktop-local' },
    attachments: { chat: false, screenshots: [] },
    createdAt: ago(50 * MIN),
  },
};

const featureWithShot = {
  shots: [{ name: 'shot0', kind: 'mock' }],
  ip: 5,
  receivedAgo: 4 * 24 * HOUR,
  envelope: {
    v: 1,
    kind: 'feature',
    title: 'Show token usage per project in Settings',
    description:
      'We share one API key across the team. A page in Settings that shows the tokens used per project and per month would let us see which project costs what. A simple table is enough, see my rough sketch.',
    app: { version: '0.8.1', channel: 'stable', surface: 'web', mode: 'desktop-server', serverVersion: '0.8.1' },
    diagnostics: {
      collectedAt: ago(4 * 24 * HOUR),
      client: {
        os: { platform: 'darwin', name: 'macOS 15.7', arch: 'x64' },
        hardware: {},
        runtime: { electron: '44.6.0' },
      },
    },
    attachments: { chat: false, screenshots: [] },
    createdAt: ago(4 * 24 * HOUR),
  },
};

const cli = {
  ip: 6,
  receivedAgo: 8 * 24 * HOUR,
  envelope: {
    v: 1,
    kind: 'issue',
    title: 'atelier login fails behind a corporate proxy',
    description:
      'Running `atelier login https://atelier.corp.example` fails with "fetch failed" on my work laptop. curl to the same address works. We need HTTPS_PROXY for everything here; the CLI does not seem to use it.',
    app: { version: '0.8.0', channel: 'stable', surface: 'cli', mode: 'cli' },
    diagnostics: {
      collectedAt: ago(8 * 24 * HOUR),
      client: {
        os: {
          platform: 'linux',
          name: 'Fedora Linux 43 (Workstation Edition)',
          release: '6.17.7-300.fc43.x86_64',
          arch: 'x64',
          locale: 'en-US',
        },
        hardware: {
          cpu: { model: 'Intel(R) Core(TM) Ultra 7 155H', cores: 22, speedMHz: 400 },
          memory: { totalBytes: 33_284_227_072, freeBytes: 12_005_009_408 },
        },
        runtime: { node: '24.11.0' },
      },
      // A proxy password the app should have hidden: the collector's scrubber takes it out and counts it.
      log: [
        'atelier 0.8.0 (linux-x64)',
        'env: HTTPS_PROXY=http://jdoe:Winter2026!@proxy.corp.example:3128',
        'login: GET https://atelier.corp.example/api/auth/config',
        'login: TypeError: fetch failed (cause: ENOTFOUND atelier.corp.example)',
      ],
      lastError: { message: 'TypeError: fetch failed', at: ago(8 * 24 * HOUR) },
    },
    attachments: { chat: false, screenshots: [] },
    createdAt: ago(8 * 24 * HOUR),
  },
};

const featureExport = {
  ip: 7,
  receivedAgo: 13 * 24 * HOUR,
  status: 'planned',
  labels: ['export'],
  seen: true,
  envelope: {
    v: 1,
    kind: 'feature',
    title: 'Export a chat as Markdown, with the tool calls',
    description:
      'I write up what the Code sessions did for my weekly notes. An export of a session as one Markdown file, with the tool calls folded as details blocks, would save me a lot of copying.',
    app: { version: '0.7.1', channel: 'beta', surface: 'desktop', mode: 'desktop-local' },
    attachments: { chat: false, screenshots: [] },
    createdAt: ago(13 * 24 * HOUR),
  },
};

const fixed = {
  ip: 8,
  receivedAgo: 20 * 24 * HOUR,
  status: 'fixed',
  labels: ['sidebar'],
  note: 'Fixed in 0.8.0 (project rename now refreshes the sidebar list).',
  seen: true,
  envelope: {
    v: 1,
    kind: 'issue',
    title: 'Sidebar keeps the old name after renaming a project',
    description:
      'When I rename a project in its settings, the sidebar keeps showing the old name until I restart the app. The project page itself shows the new name right away.',
    app: { version: '0.7.1', channel: 'stable', surface: 'desktop', mode: 'desktop-server', serverVersion: '0.7.1' },
    diagnostics: {
      collectedAt: ago(20 * 24 * HOUR),
      client: {
        os: { platform: 'darwin', name: 'macOS 26.0', arch: 'x64' },
        hardware: {
          model: 'MacBookPro16,1',
          cpu: { model: 'Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz', cores: 16, speedMHz: 2300 },
          memory: { totalBytes: 34_359_738_368 },
        },
        runtime: { electron: '44.2.0' },
      },
      backend: {
        kind: 'server',
        os: { platform: 'linux', name: 'Debian GNU/Linux 13 (trixie)', arch: 'arm64' },
        hardware: { cpu: { model: 'Neoverse-N1', cores: 4 }, memory: { totalBytes: 25_769_803_776 } },
        runtime: { node: '24.10.0' },
        container: true,
      },
    },
    attachments: { chat: false, screenshots: [] },
    createdAt: ago(20 * 24 * HOUR),
  },
};

export const FIXTURES = [mac, windows, server, featureNoDiagnostics, featureWithShot, cli, featureExport, fixed];
