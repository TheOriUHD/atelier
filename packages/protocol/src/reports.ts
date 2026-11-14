/**
 * Issue reports and feature requests (ARCHITECTURE §26): what the app sends to the collector at `REPORTS_URL` when a
 * person presses Send, and nothing else, ever. One format for the app, the terminal app, the collector Worker
 * (deploy/reports) and the admin panel (apps/admin), so they can't drift apart.
 *
 * A report is a multipart body: a `report` part (JSON, `ReportEnvelope`), an optional `chat` part (JSON, `ReportChat`)
 * and up to `REPORT_LIMITS.screenshots` pictures `shot0`…`shot3`. Diagnostics and chats are redacted before they leave
 * (packages/core/src/reports): no keys, tokens, passwords, mail addresses or home folders, and no free text the person
 * didn't choose to attach. The collector scrubs once more before it stores anything.
 *
 * Against floods: every report carries a proof of work for a challenge the collector signed (`POW_*`), and the collector
 * limits reports per address and per day and refuses bodies over `REPORT_LIMITS.bodyBytes`.
 */
import { z } from 'zod';

/** The Atelier developer's collector. A fork points its builds at its own with ATELIER_REPORTS_URL. */
export const REPORTS_URL = 'https://reports.atelierhq.dev';

export const ReportKind = z.enum(['issue', 'feature']);
export type ReportKind = z.infer<typeof ReportKind>;

export const REPORT_KIND_LABELS: Record<ReportKind, string> = { issue: 'Issue', feature: 'Feature request' };

export const REPORT_LIMITS = {
  titleMin: 6,
  titleMax: 140,
  descriptionMin: 20,
  descriptionMax: 20_000,
  contactMax: 200,
  screenshots: 4,
  /** One picture, after the app scaled and compressed it. */
  screenshotBytes: 2_500_000,
  /** The longest side the app scales a picture down to. */
  screenshotSide: 2560,
  /** The `report` part (diagnostics included). */
  reportBytes: 1_000_000,
  /** The `chat` part. */
  chatBytes: 3_000_000,
  /** The whole request. */
  bodyBytes: 14_000_000,
  logLines: 200,
} as const;

/** The picture types a report may carry. */
export const REPORT_IMAGE_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;
export const ReportImageType = z.enum(REPORT_IMAGE_TYPES);

// ------------------------------------------------------------------ what people write

/**
 * Why a title or description can't be sent yet, in a sentence, or null when it can. The bar is low on purpose (a
 * sentence or two), but it must say something: padding ("Chat broken AAAAAAAAAA"), one word repeated or a row of
 * punctuation doesn't count towards it.
 */
export function reportTextProblem(field: 'title' | 'description', text: string): string | null {
  const min = field === 'title' ? REPORT_LIMITS.titleMin : REPORT_LIMITS.descriptionMin;
  const max = field === 'title' ? REPORT_LIMITS.titleMax : REPORT_LIMITS.descriptionMax;
  const trimmed = text.trim();
  if (!trimmed) return field === 'title' ? 'Give it a title.' : 'Describe it in a sentence or two.';
  if (trimmed.length > max) return `That's too long: at most ${max.toLocaleString('en')} characters.`;
  // Letters only: "1000000 tokens" and a row of "=====" in pasted output are fine.
  if (/(\p{L})\1{5,}/iu.test(trimmed)) return 'Leave out the repeated characters.';
  // What counts: letters and digits, each run of the same one at most twice ("soooo" counts as "soo").
  const meaningful = trimmed.replace(/(.)\1{2,}/gsu, '$1$1').replace(/[^\p{L}\p{N}]+/gu, '');
  const words = trimmed.split(/[^\p{L}\p{N}]+/u).filter((w) => /\p{L}/u.test(w));
  const scripts = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(trimmed);
  const minWords = field === 'title' ? 2 : 4;
  if (meaningful.length < min || (!scripts && words.length < minWords)) {
    return field === 'title' ? 'Make the title a few words long.' : 'Say a little more: what happened, and what you expected.';
  }
  if (new Set(meaningful.toLowerCase()).size < 5) return field === 'title' ? 'Make the title a few words long.' : 'Say a little more: what happened, and what you expected.';
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w.toLowerCase(), (counts.get(w.toLowerCase()) ?? 0) + 1);
  if (words.length >= 6 && Math.max(...counts.values()) > words.length / 2) return 'Say it in your own words rather than one word repeated.';
  return null;
}

// ------------------------------------------------------------------ diagnostics

const Str = (max = 200) => z.string().max(max);
const Num = z.number().finite();

export const ReportGpu = z.object({
  name: Str(),
  vendor: Str(80).optional(),
  driver: Str(80).optional(),
  vramBytes: Num.nonnegative().optional(),
  vramFreeBytes: Num.nonnegative().optional(),
  /** Where it was read: `electron`, `webgl`, `nvidia-smi`, `system_profiler`, `wmi`, `lspci`, `comfyui`. */
  source: Str(40),
});
export type ReportGpu = z.infer<typeof ReportGpu>;

export const ReportDisplay = z.object({
  width: Num,
  height: Num,
  scale: Num,
  refreshHz: Num.optional(),
  primary: z.boolean().optional(),
});

/** One computer: the one the person uses (`client`) or the one Atelier's backend runs on (`backend`). */
export const ReportSystem = z.object({
  os: z.object({
    platform: Str(20),
    /** "macOS 26.1", "Windows 11 Pro 24H2", "Ubuntu 24.04.3 LTS". */
    name: Str(120).optional(),
    release: Str(80).optional(),
    arch: Str(20).optional(),
    locale: Str(40).optional(),
    timeZone: Str(60).optional(),
  }),
  hardware: z
    .object({
      /** "Mac16,1", "MacBookPro18,3"; never a serial number. */
      model: Str(80).optional(),
      cpu: z.object({ model: Str(), cores: Num.int().nonnegative(), speedMHz: Num.optional() }).optional(),
      memory: z.object({ totalBytes: Num.nonnegative(), freeBytes: Num.nonnegative().optional() }).optional(),
      gpus: z.array(ReportGpu).max(16).optional(),
      /** The disk Atelier's data folder is on. */
      disk: z.object({ totalBytes: Num.nonnegative(), freeBytes: Num.nonnegative() }).optional(),
      displays: z.array(ReportDisplay).max(16).optional(),
    })
    .default({}),
  runtime: z.object({ node: Str(40).optional(), electron: Str(40).optional(), chrome: Str(40).optional(), browser: Str(80).optional() }).default({}),
  /** Running in a container (Docker, Podman): the usual way a server runs. */
  container: z.boolean().optional(),
  uptimeSeconds: Num.nonnegative().optional(),
});
export type ReportSystem = z.infer<typeof ReportSystem>;

export const ReportProvider = z.object({
  type: Str(40),
  /** `localhost:11434`, `api.openai.com`, `private network`, `other host`: never a private address or name. */
  host: Str(120),
  enabled: z.boolean(),
  /** A key is set (its value never leaves). */
  keySet: z.boolean(),
  models: z.array(Str(160)).max(60).optional(),
  status: z.object({ ok: z.boolean(), version: Str(80).optional(), latencyMs: Num.optional(), modelCount: Num.optional(), error: Str(400).optional() }).optional(),
});
export type ReportProvider = z.infer<typeof ReportProvider>;

export const ReportInferenceModel = z.object({
  name: Str(160),
  sizeBytes: Num.nonnegative().optional(),
  vramBytes: Num.nonnegative().optional(),
  quantization: Str(40).optional(),
  family: Str(60).optional(),
  parameters: Str(40).optional(),
  contextLength: Num.optional(),
  expiresAt: Str(60).optional(),
});

/** A local inference server the backend could reach: what it runs and has loaded right now. */
export const ReportInference = z.object({
  kind: Str(40),
  host: Str(120),
  version: Str(80).optional(),
  models: z.array(ReportInferenceModel).max(100).optional(),
  loaded: z.array(ReportInferenceModel).max(32).optional(),
  devices: z.array(z.object({ name: Str(), type: Str(40).optional(), vramBytes: Num.optional(), vramFreeBytes: Num.optional() })).max(16).optional(),
  /** llama.cpp: parallel slots. ComfyUI: Python and PyTorch versions, in `notes`. */
  slots: Num.optional(),
  notes: z.record(z.string().max(60), Str(200)).optional(),
  error: Str(400).optional(),
});
export type ReportInference = z.infer<typeof ReportInference>;

export const ReportApp = z.object({
  version: Str(40),
  channel: Str(20).optional(),
  packaged: z.boolean().optional(),
  surface: z.enum(['desktop', 'web', 'cli']),
  /** Desktop on its own backend, desktop or browser on a server, or the terminal app. */
  mode: z.enum(['desktop-local', 'desktop-server', 'web', 'cli']),
  serverVersion: Str(40).optional(),
  window: z.object({ width: Num, height: Num, ratio: Num }).optional(),
  theme: z.enum(['light', 'dark']).optional(),
  language: Str(40).optional(),
});
export type ReportApp = z.infer<typeof ReportApp>;

export const ReportDiagnostics = z.object({
  collectedAt: Num,
  client: ReportSystem.optional(),
  backend: ReportSystem.extend({
    kind: z.enum(['desktop', 'server']),
    /** Size of the database and of the stored files. */
    dataBytes: Num.optional(),
    blobBytes: Num.optional(),
    counts: z.record(z.string().max(40), Num).optional(),
  }).optional(),
  /** The effective settings, redacted (`redactSettings`): secrets, headers, addresses and free text left out. */
  settings: z.unknown().optional(),
  /** The person's own preferences, redacted the same way. */
  prefs: z.unknown().optional(),
  providers: z.array(ReportProvider).max(40).optional(),
  imageProviders: z.array(ReportProvider).max(40).optional(),
  inference: z.array(ReportInference).max(12).optional(),
  connectors: z.array(z.object({ type: Str(40), status: Str(40), tools: Num.optional(), error: Str(400).optional() })).max(80).optional(),
  computerUse: z.object({ available: z.boolean(), enabled: z.boolean().optional(), helper: Str(80).optional(), notes: z.record(z.string().max(60), Str(200)).optional() }).optional(),
  /** The end of the desktop's main log, redacted line by line. */
  log: z.array(Str(2000)).max(REPORT_LIMITS.logLines).optional(),
  lastError: z.object({ message: Str(2000), at: Num }).optional(),
  /** Small facts that fit nowhere else: `{ "update channel": "beta" }`. */
  notes: z.record(z.string().max(60), Str(400)).optional(),
});
export type ReportDiagnostics = z.infer<typeof ReportDiagnostics>;

// ------------------------------------------------------------------ an attached chat

export const ReportPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), cut: Num.optional() }),
  z.object({ type: z.literal('thinking'), text: z.string(), cut: Num.optional(), redacted: z.boolean().optional() }),
  z.object({
    type: z.literal('tool_call'),
    id: Str(120),
    name: Str(120),
    /** The input as JSON text, maybe shortened (`cut`: how many characters were left out). */
    input: z.string(),
    cut: Num.optional(),
    /** A sub-agent the call started: its title, how it ended, and its last messages. */
    child: z.object({ title: Str(300), mode: Str(20), status: Str(40), messageCount: Num, messages: z.array(z.lazy(() => ReportMessage)).max(12) }).optional(),
  }),
  z.object({ type: z.literal('tool_result'), callId: Str(120), text: z.string(), cut: Num.optional(), isError: z.boolean().optional(), images: Num.optional() }),
  z.object({ type: z.literal('image'), mime: Str(80) }),
  z.object({ type: z.literal('document'), mime: Str(120), name: Str(300) }),
  z.object({ type: z.literal('context'), text: z.string(), cut: Num.optional() }),
]);
export type ReportPart = z.infer<typeof ReportPart>;

export interface ReportMessage {
  /** Its place in the conversation (0 is the first message). */
  index: number;
  role: 'user' | 'assistant' | 'tool';
  kind: string;
  createdAt: number;
  model?: string | undefined;
  author?: string | undefined;
  stopReason?: string | undefined;
  error?: string | undefined;
  usage?: Record<string, number> | undefined;
  parts: ReportPart[];
}
export const ReportMessage: z.ZodType<ReportMessage> = z.object({
  index: Num.int().nonnegative(),
  role: z.enum(['user', 'assistant', 'tool']),
  kind: Str(40),
  createdAt: Num,
  model: Str(160).optional(),
  author: Str(80).optional(),
  stopReason: Str(60).optional(),
  error: Str(2000).optional(),
  usage: z.record(z.string().max(40), Num).optional(),
  parts: z.array(ReportPart).max(400),
});

export const ReportChat = z.object({
  session: z.object({
    mode: Str(20),
    title: Str(300),
    model: Str(160).optional(),
    provider: Str(40).optional(),
    effort: Str(40).optional(),
    permissionMode: Str(40).optional(),
    status: Str(40),
    createdAt: Num,
    updatedAt: Num,
    /** The folder's name only, and where it is (`local`, `ssh`, `scratch`). */
    workspace: z.object({ name: Str(200), kind: Str(40) }).optional(),
    todos: z.array(z.object({ content: Str(500), status: Str(20) })).max(100).optional(),
    usage: z.record(z.string().max(40), Num).optional(),
    coop: z.boolean().optional(),
  }),
  /** How much of the conversation is here: all of it, or its start and its latest messages (`omitted` between). */
  coverage: z.object({
    total: Num.int().nonnegative(),
    included: Num.int().nonnegative(),
    omitted: z.array(z.object({ from: Num.int(), to: Num.int() })).max(8),
    /** Parts shortened to fit. */
    shortened: Num.int().nonnegative(),
  }),
  messages: z.array(ReportMessage).max(4000),
});
export type ReportChat = z.infer<typeof ReportChat>;

// ------------------------------------------------------------------ the report

export const ReportScreenshotInfo = z.object({ name: z.string().regex(/^shot[0-3]$/), mime: ReportImageType, width: Num.int().positive(), height: Num.int().positive(), bytes: Num.int().positive() });

export const ReportEnvelope = z.object({
  v: z.literal(1),
  kind: ReportKind,
  title: z.string().min(1).max(REPORT_LIMITS.titleMax),
  description: z.string().min(1).max(REPORT_LIMITS.descriptionMax),
  /** How to reach the person, if they want an answer: whatever they typed. */
  contact: z.string().max(REPORT_LIMITS.contactMax).optional(),
  app: ReportApp,
  diagnostics: ReportDiagnostics.optional(),
  attachments: z.object({ chat: z.boolean(), screenshots: z.array(ReportScreenshotInfo).max(REPORT_LIMITS.screenshots) }),
  createdAt: Num,
});
export type ReportEnvelope = z.infer<typeof ReportEnvelope>;

/** What the collector answers to a report it kept: an id the person can quote ("I-7F3K2Q"). */
export const ReportReceipt = z.object({ id: z.string(), receivedAt: Num });
export type ReportReceipt = z.infer<typeof ReportReceipt>;

// ------------------------------------------------------------------ proof of work

/** `POST /v1/challenge` answers `{ challenge, bits, expiresAt }`; the report must then carry a nonce for it. */
export const ReportChallenge = z.object({ challenge: z.string().max(300), bits: z.number().int().min(0).max(30), expiresAt: Num });
export type ReportChallenge = z.infer<typeof ReportChallenge>;

export const POW_HEADERS = { challenge: 'x-atelier-challenge', nonce: 'x-atelier-nonce' } as const;

/**
 * What is hashed for the proof: the challenge, the hash of the body's parts and the nonce. `contentHash` is the SHA-256
 * (hex) of the lines `<part name>:<SHA-256 hex of its bytes>`, in the order the parts are sent, joined with "\n".
 */
export const powInput = (challenge: string, contentHash: string, nonce: string): string => `${challenge}:${contentHash}:${nonce}`;

export const contentHashInput = (parts: readonly { name: string; sha256: string }[]): string => parts.map((p) => `${p.name}:${p.sha256}`).join('\n');

/** How many zero bits a hash starts with. */
export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** "I-7F3K2Q": the kind's letter and six Crockford base-32 characters (no I, L, O, U). */
export const REPORT_ID = /^[IF]-[0-9A-HJKMNP-TV-Z]{6}$/;
