/**
 * Personal providers (ARCHITECTURE §8): model servers on one of a person's own computers (Ollama, llama.cpp, LM Studio
 * or another OpenAI-compatible server) and that computer's ChatGPT Chat window. A server reaches them through the
 * desktop app there (device services, §21). Only their owner sees and uses their models, and only while that computer
 * is connected; the admin's providers stay shared.
 */
import { z } from 'zod';
import { ProviderStatus, ProviderType } from './models.ts';
import { ProviderConfig } from './settings.ts';

export const PersonalProviderType = ProviderType.extract(['ollama', 'llamacpp', 'openai-compatible', 'chatgpt-chat']);
export type PersonalProviderType = z.infer<typeof PersonalProviderType>;

const ID = /^u-[a-z0-9]{10}$/;
/** `u-` and ten lowercase letters or digits. An admin provider never has an id of this shape (`providers.save` refuses it). */
export const PersonalProviderId = z.string().regex(ID, 'u- and ten lowercase letters or digits');
export const isPersonalProviderId = (id: string): boolean => ID.test(id);

/** A new personal provider's id, made where it is added: the desktop lends its address under this id before the server tests it. */
export function newPersonalProviderId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `u-${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % alphabet.length]).join('')}`;
}

const Options = ProviderConfig.pick({ parallelRequests: true, modelsAtOnce: true, vramGiB: true });

export const PersonalProvider = Options.extend({
  id: z.string(),
  type: PersonalProviderType,
  name: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean(),
  /** The computer it runs on, and that computer's name. */
  deviceId: z.string(),
  deviceName: z.string(),
  /** That computer is connected and lends it right now. */
  online: z.boolean(),
  /** An API key is stored for it (the person's own secret). */
  hasKey: z.boolean(),
  /** The last check, while it was online. */
  status: ProviderStatus.optional(),
  createdAt: z.number(),
});
export type PersonalProvider = z.infer<typeof PersonalProvider>;

/** A personal provider as entered: the key is passed raw and kept as the person's own secret. */
export const PersonalProviderDraft = Options.extend({
  id: PersonalProviderId,
  type: PersonalProviderType,
  name: z.string().trim().min(1).max(80),
  baseUrl: z.url().max(2048),
  apiKey: z.string().max(10_000).optional(),
  enabled: z.boolean().optional(),
});
export type PersonalProviderDraft = z.infer<typeof PersonalProviderDraft>;

/** A model server the desktop found on its computer's default ports. */
export const LocalServer = z.object({ type: PersonalProviderType, baseUrl: z.string(), label: z.string() });
export type LocalServer = z.infer<typeof LocalServer>;
