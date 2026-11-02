/** The composer's image model: a choice per conversation, offered once there are two models to choose between. */
import { useMemo, useState } from 'react';
import type { ImageModelInfo, SessionSummary } from '@atelier/protocol';
import { toast } from '../../components/ui/index.ts';
import { useImageModels, usePrefs, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

export interface ImageModelChoice {
  /** The chosen model; null uses the person's default. */
  ref: string | null;
  onChange(ref: string | null): void;
}

export interface ImageModelGroup {
  id: string;
  label: string;
  models: ImageModelInfo[];
  /** Every model here is on a computer that isn't connected. */
  offline: boolean;
}

/**
 * Image models grouped for a picker, as `useModelGroups` does for text: by provider, and the person's own by the computer
 * they run on, which is what the picker shows as the group's name. `providerName` names the shared providers.
 */
export function imageModelGroups(models: readonly ImageModelInfo[], providerName: (id: string) => string | undefined): ImageModelGroup[] {
  const groups = new Map<string, ImageModelInfo[]>();
  for (const m of models) {
    const key = m.personal ? `device:${m.personal.deviceId}` : m.providerId;
    if (!m.hidden) groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups].map(([id, list]) => ({
    id,
    label: list[0]!.personal?.deviceName ?? providerName(id) ?? id,
    models: [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.order - b.order || a.displayName.localeCompare(b.displayName)),
    offline: list.every((m) => m.available === false),
  }));
}

/** One line under an image model in a picker; a personal one whose computer is away says so, and can't be chosen. */
export function imageModelSubtitle(m: ImageModelInfo): string | undefined {
  return m.available === false ? `${m.personal?.deviceName ?? 'Its computer'} isn’t connected` : m.description;
}

/** Hidden models are an admin's to keep from the picker, their own included. */
function useVisibleImageModels(): ImageModelInfo[] {
  const { data } = useImageModels();
  return useMemo(() => (data ?? []).filter((m) => !m.hidden), [data]);
}

/** The models by provider and by computer, favorites first and then by order and name, as the text picker groups them. */
export function useImageModelGroups(): ImageModelGroup[] {
  const models = useVisibleImageModels();
  const { settings } = useSettings();
  return useMemo(() => {
    const names = new Map(settings?.imageProviders?.map((p) => [p.id, p.name]));
    return imageModelGroups(models, (id) => names.get(id));
  }, [models, settings?.imageProviders]);
}

/** What "Default" comes to: the person's model, the server's, else the first. */
export function useDefaultImageModel(): ImageModelInfo | undefined {
  const models = useVisibleImageModels();
  const { settings } = useSettings();
  const { prefs } = usePrefs();
  return models.find((m) => m.ref === prefs?.models.image) ?? models.find((m) => m.ref === settings?.models.defaults.image) ?? models[0];
}

function useOffered(): boolean {
  const models = useVisibleImageModels();
  const { settings } = useSettings();
  // In this order: `imageGeneration` is missing from an older server's settings, which has no image models either.
  return models.length >= 2 && !!settings?.imageGeneration?.enabled;
}

/** For a conversation that exists: saved on it, from its next image. */
export function useSessionImageModel(session: SessionSummary | null | undefined): ImageModelChoice | undefined {
  const offered = useOffered();
  if (!session || !offered) return undefined;
  return {
    ref: session.imageModel ?? null,
    onChange: (imageModel) =>
      void rpc()
        .call('sessions.update', { id: session.id, imageModel })
        .catch((e: unknown) => toast.error(describeError(e).message)),
  };
}

/** For a conversation about to start: kept here until it is created with it. */
export function useNewImageModel(): ImageModelChoice | undefined {
  const offered = useOffered();
  const [ref, setRef] = useState<string | null>(null);
  return offered ? { ref, onChange: setRef } : undefined;
}
