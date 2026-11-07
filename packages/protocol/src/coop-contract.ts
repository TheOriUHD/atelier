/**
 * What co-op guests and hosts say to each other over the encrypted channel (ARCHITECTURE §24), in two directions:
 *
 * - `CoopContract`, guest → host: a guest's backend acts in the host's session for its person. Narrow on purpose: never
 *   the host's whole app contract, and every handler checks the guest's part in the session (packages/core/src/coop/
 *   host.ts). Events carry the session's run events to the guest.
 * - `PeerContract`, host → guest: the host asks a guest's computer for what only it has, the models and connectors the
 *   guest brings (their keys never leave it).
 *
 * Both run as JSON-RPC over the one channel, each on its own lane (`CoopFrame`).
 */
import { z } from 'zod';
import { CoopSettings, CoopState, ModelsChoice, Participant } from './coop.ts';
import { ArtifactSummary, ChangePreview, ContextUsage, ElicitationAnswer, PermissionAnswer, QuestionAnswer, RunEvent, SessionSnapshot, SessionUsage } from './domain.ts';
import { Part } from './messages.ts';
import { ModelInfo } from './models.ts';

const Ok = z.object({ ok: z.literal(true) });
const Empty = z.object({});

/** The guest's first words once the channel is up: who they are and what they bring. */
export const CoopHello = z.object({
  name: z.string().min(1).max(80),
  /** A small image as a data URL. */
  avatar: z.string().max(90_000).nullable(),
  models: ModelsChoice,
  /** Their own model's ref on their computer, when they answer with their own. */
  model: z.string().max(300).nullable(),
  version: z.string().max(40),
});
export type CoopHello = z.infer<typeof CoopHello>;

export const CoopWelcome = z.object({
  /** The host still has to let them in (`admitted` follows), or did already (a pinned guest). */
  admitted: z.boolean(),
  participantId: z.string(),
  hostName: z.string(),
  sessionId: z.string(),
  title: z.string(),
  mode: z.enum(['chat', 'work', 'code']),
  /** Both sides show these to compare. */
  fingerprint: z.array(z.string()).length(3),
});
export type CoopWelcome = z.infer<typeof CoopWelcome>;

export const CoopContract = {
  procedures: {
    'coop.hello': { input: CoopHello, output: CoopWelcome },
    'coop.state': { input: Empty, output: CoopState.nullable() },
    'coop.subscribe': { input: Empty, output: SessionSnapshot },
    'coop.unsubscribe': { input: Empty, output: Ok },
    'coop.models': { input: z.object({ models: ModelsChoice, model: z.string().max(300).nullable() }), output: CoopState },
    'coop.typing': { input: Empty, output: Ok },
    'coop.leave': { input: Empty, output: Ok },
    'chat.send': { input: z.object({ parentId: z.string().nullable().optional(), parts: z.array(Part).min(1) }), output: z.object({ userMessageId: z.string() }) },
    'chat.queue': { input: z.object({ parts: z.array(Part).min(1), joinTurn: z.boolean().optional() }), output: z.object({ id: z.string(), queued: z.boolean() }) },
    'chat.unqueue': { input: z.object({ id: z.string() }), output: z.object({ parts: z.array(Part) }) },
    'chat.sendNow': { input: z.object({ id: z.string() }), output: Ok },
    'chat.stop': { input: Empty, output: Ok },
    'chat.retry': { input: z.object({ messageId: z.string() }), output: Ok },
    'chat.continue': { input: Empty, output: Ok },
    'chat.edit': { input: z.object({ messageId: z.string(), parts: z.array(Part).min(1) }), output: z.object({ userMessageId: z.string() }) },
    'chat.respond': { input: z.object({ interactionId: z.string(), answer: z.union([PermissionAnswer, QuestionAnswer, ElicitationAnswer]) }), output: Ok },
    'chat.contextBreakdown': { input: Empty, output: z.object({ context: ContextUsage.nullable(), usage: SessionUsage }) },
    'chat.changePreview': { input: z.object({ interactionId: z.string() }), output: ChangePreview },
    'chat.editPreview': { input: z.object({ callId: z.string() }), output: ChangePreview },
    /** The session's own changes (Code's Diff pane), never the rest of the folder. */
    'session.diff': { input: z.object({ path: z.string().max(4096).optional() }), output: z.object({ diff: z.string(), truncated: z.boolean(), base: z.string().nullable() }) },
    'artifacts.list': { input: Empty, output: z.array(ArtifactSummary) },
    /** A blob this session's messages, files or artifacts refer to (images, attachments), base64. */
    'blob.get': { input: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }), output: z.object({ mime: z.string(), dataBase64: z.string() }) },
    /** A file the guest attaches to their message: it is stored on the host for this session. */
    'files.upload': {
      input: z.object({ name: z.string().min(1).max(255), mime: z.string().min(1).max(200), dataBase64: z.string().max(46_000_000) }),
      output: z.object({ id: z.string(), name: z.string(), mime: z.string(), size: z.number(), blob: z.string(), kind: z.string(), tokens: z.number().nullable(), createdAt: z.number() }),
    },
  },
  events: {
    'session.event': z.object({ seq: z.number().int().nonnegative(), event: RunEvent }),
    /** The host let them in. */
    admitted: z.object({ participantId: z.string() }),
    /** The host declined, removed them, or ended co-op; `copy`: the host lets them keep a copy (they ask for it). */
    gone: z.object({ reason: z.enum(['declined', 'removed', 'ended']), copy: z.boolean() }),
    /** The session's title, mode or co-op settings changed. */
    'session.changed': z.object({ title: z.string(), mode: z.enum(['chat', 'work', 'code']), settings: CoopSettings, participants: z.array(Participant) }),
  },
} as const;
export type CoopContract = typeof CoopContract;

/** A request a guest's own model runs, as the host's run builds it (providers/types.ts ChatRequest without its signal). */
export const PeerChatRequest = z.object({
  model: z.string(),
  system: z.array(z.object({ text: z.string(), cache: z.boolean().optional() })),
  messages: z.array(z.unknown()),
  tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) })).optional(),
  toolChoice: z.union([z.enum(['auto', 'none']), z.object({ name: z.string() })]).optional(),
  maxOutputTokens: z.number().int().positive(),
  temperature: z.number().optional(),
  effort: z.string().nullable().optional(),
  contextLength: z.number().optional(),
});
export type PeerChatRequest = z.infer<typeof PeerChatRequest>;

export const PeerContract = {
  procedures: {
    /** What the guest's model is: window, output, capabilities, tier (the host's thresholds and history need it). */
    'model.describe': { input: z.object({ ref: z.string().max(300) }), output: ModelInfo },
    /** Runs one request on the guest's model; its stream events come as `model.event` with this `streamId`, then it returns. */
    'model.stream': { input: z.object({ streamId: z.string(), request: PeerChatRequest }), output: Ok },
    'model.cancel': { input: z.object({ streamId: z.string() }), output: Ok },
    /** The guest's own connectors' tools, for their turns. */
    'mcp.list': { input: Empty, output: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()), readOnly: z.boolean() })) },
    'mcp.call': { input: z.object({ name: z.string(), input: z.unknown() }), output: z.object({ content: z.array(z.unknown()), isError: z.boolean().optional() }) },
  },
  events: {
    'model.event': z.object({ streamId: z.string(), event: z.unknown() }),
  },
} as const;
export type PeerContract = typeof PeerContract;

/** One frame on the channel: which contract it belongs to, and the JSON-RPC message. */
export const CoopFrame = z.object({ lane: z.enum(['coop', 'peer']), message: z.unknown() });
export type CoopFrame = z.infer<typeof CoopFrame>;
