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
  providerId: string;
  label: string;
  models: ImageModelInfo[];
}

/** Hidden models are an admin's to keep from the picker, their own included. */
function useVisibleImageModels(): ImageModelInfo[] {
  const { data } = useImageModels();
  return useMemo(() => (data ?? []).filter((m) => !m.hidden), [data]);
}

/** The models by provider, favorites first and then by order and name, as the text picker groups them. */
export function useImageModelGroups(): ImageModelGroup[] {
  const models = useVisibleImageModels();
  const { settings } = useSettings();
  return useMemo(() => {
    if (models.length === 0) return [];
    const names = new Map(settings?.imageProviders.map((p) => [p.id, p.name]));
    const groups = new Map<string, ImageModelInfo[]>();
    for (const m of models) groups.set(m.providerId, [...(groups.get(m.providerId) ?? []), m]);
    return [...groups].map(([providerId, list]) => ({
      providerId,
      label: names.get(providerId) ?? providerId,
      models: list.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.order - b.order || a.displayName.localeCompare(b.displayName)),
    }));
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
  return models.length >= 2 && !!settings?.imageGeneration.enabled;
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
