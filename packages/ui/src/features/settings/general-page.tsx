import { useMemo, useReducer } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { AudioKind, UserPrefs } from '@atelier/protocol';
import { SegmentedControl, Select, Switch, type SegmentedControlItem } from '../../components/ui/index.ts';
import { makesAudio, makesPictures, makesVideo, useAudioGeneration, useImageGeneration, useImageModels, useModels, useSettings, useVideoGeneration } from '../../lib/queries.ts';
import { notificationsBlocked } from '../work/notifications.ts';
import { isUnavailable, ModelSelect } from './model-select.tsx';
import type { SettingId } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { usePref } from './use-setting.ts';

type Appearance = UserPrefs['appearance'];

const THEMES: SegmentedControlItem<Appearance['theme']>[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

/** Each option previews itself in its own typeface. */
const CHAT_FONTS: { value: Appearance['chatFont']; label: string; family: string }[] = [
  { value: 'serif', label: 'Atelier Serif', family: 'var(--at-font-serif)' },
  { value: 'sans', label: 'Atelier Sans', family: 'var(--at-font-sans)' },
  { value: 'system', label: 'System', family: 'var(--at-font-system)' },
  { value: 'dyslexic', label: 'OpenDyslexic', family: 'var(--at-font-dyslexic)' },
];

const TEXT_SIZES: SegmentedControlItem<Appearance['textSize']>[] = [
  { value: 's', label: 'Small' },
  { value: 'm', label: 'Medium' },
  { value: 'l', label: 'Large' },
];

const WIDTHS: SegmentedControlItem<Appearance['transcriptWidth']>[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'medium', label: 'Medium' },
  { value: 'wide', label: 'Wide' },
];

const MOTION: SegmentedControlItem<Appearance['motion']>[] = [
  { value: 'system', label: 'System' },
  { value: 'reduced', label: 'Reduced' },
];

export function GeneralPage() {
  const chatFont = usePref<Appearance['chatFont']>(['appearance', 'chatFont']);
  const images = useImageGeneration();
  const videos = useVideoGeneration();
  const audio = useAudioGeneration();
  return (
    <>
      <SettingsSection title="Appearance">
        <SegmentedRow id="appearance.theme" field="theme" items={THEMES} variant="icon" />
        <SettingRow id="appearance.chatFont" setting={chatFont}>
          {(label) => (
            <Select
              {...label}
              options={CHAT_FONTS}
              value={chatFont.value}
              onValueChange={(v) => void chatFont.set(v)}
              renderOption={(o) => <span style={{ fontFamily: CHAT_FONTS.find((f) => f.value === o.value)?.family }}>{o.label}</span>}
            />
          )}
        </SettingRow>
        <SegmentedRow id="appearance.textSize" field="textSize" items={TEXT_SIZES} />
        <SegmentedRow id="appearance.transcriptWidth" field="transcriptWidth" items={WIDTHS} />
        <SegmentedRow id="appearance.motion" field="motion" items={MOTION} />
      </SettingsSection>
      <SettingsSection title="Chat">
        <DefaultModelRow />
        <RememberModelRow />
        {images && <DefaultImageModelRow />}
        {videos && <DefaultVideoModelRow />}
        {audio && (
          <>
            <DefaultSoundModelRow kind="speech" />
            <DefaultSoundModelRow kind="music" />
            <DefaultSoundModelRow kind="sound" />
          </>
        )}
      </SettingsSection>
      <SettingsSection title="Notifications">
        <NotificationRow id="notifications.taskFinished" field="taskFinished" />
        <NotificationRow id="notifications.permissionNeeded" field="permissionNeeded" />
      </SettingsSection>
    </>
  );
}

/** Turning one on is a click, so the browser may ask for permission then; a refusal shows under the row. */
function NotificationRow({ id, field }: { id: SettingId; field: keyof UserPrefs['notifications'] }) {
  const setting = usePref<boolean>(['notifications', field]);
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  const blocked = setting.value && notificationsBlocked();
  return (
    <SettingRow id={id} setting={setting} error={blocked ? 'Notifications are blocked for Atelier. Allow them in your browser’s site settings or your system settings.' : null}>
      {(label) => (
        <Switch
          {...label}
          // Controlled from the first render, before the preferences have loaded.
          checked={!!setting.value}
          onCheckedChange={(on) => {
            void setting.set(on);
            if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().then(recheck);
          }}
        />
      )}
    </SettingRow>
  );
}

/** Unset names what the server's default comes to now, so the person sees which model new chats get. */
function DefaultModelRow() {
  const setting = usePref<string | undefined>(['models', 'chat']);
  const { data: models = [] } = useModels();
  const { settings } = useSettings();
  const providerNames = useMemo(() => new Map(settings?.providers.map((p) => [p.id, p.name])), [settings?.providers]);
  const visible = models.filter((m) => !m.hidden);
  const server = visible.find((m) => m.ref === settings?.models.defaults.chat) ?? visible[0];
  const named = server ? ` (${server.displayName})` : '';
  const unsetLabel = `Server default${named}`;
  const warning = isUnavailable(setting.value, visible) ? `This model is no longer available. New chats start with the server default${named} until you choose another.` : null;
  return (
    <SettingRow id="prefs.models.chat" setting={setting} error={warning}>
      {(label) => <ModelSelect {...label} setting={setting} unsetLabel={unsetLabel} models={visible} providerNames={providerNames} />}
    </SettingRow>
  );
}

/** On by default: the model picked in a conversation becomes the one new conversations start with. */
function RememberModelRow() {
  const setting = usePref<boolean | undefined>(['models', 'rememberLast']);
  return (
    <SettingRow id="prefs.models.rememberLast" setting={setting}>
      {(label) => <Switch {...label} checked={setting.value !== false} onCheckedChange={(on) => void setting.set(on)} />}
    </SettingRow>
  );
}

/** There's nothing to choose from until an image provider is added, or while image generation is off. */
function DefaultImageModelRow() {
  const setting = usePref<string | undefined>(['models', 'image']);
  const { data: models = [] } = useImageModels();
  const { settings } = useSettings();
  const providerNames = useMemo(() => new Map(settings?.imageProviders?.map((p) => [p.id, p.name])), [settings?.imageProviders]);
  // Video and sound models are listed beside the pictures' and have rows of their own.
  const visible = models.filter((m) => !m.hidden && makesPictures(m));
  if (!settings?.imageGeneration?.enabled || (visible.length === 0 && !setting.value)) return null;
  const server = visible.find((m) => m.ref === settings?.models.defaults.image) ?? visible[0];
  const named = server ? ` (${server.displayName})` : '';
  const warning = isUnavailable(setting.value, visible) ? `This model is no longer available. Your images use the server default${named} until you choose another.` : null;
  return (
    <SettingRow id="prefs.models.image" setting={setting} error={warning}>
      {(label) => <ModelSelect {...label} setting={setting} unsetLabel={`Server default${named}`} models={visible} providerNames={providerNames} />}
    </SettingRow>
  );
}

/** The same for video: nothing to choose until a video provider is added, or while videos are off. */
function DefaultVideoModelRow() {
  const setting = usePref<string | undefined>(['models', 'video']);
  const { data: models = [] } = useImageModels();
  const { settings } = useSettings();
  const providerNames = useMemo(() => new Map(settings?.imageProviders?.map((p) => [p.id, p.name])), [settings?.imageProviders]);
  const visible = models.filter((m) => !m.hidden && makesVideo(m));
  if (!settings?.imageGeneration?.enabled || settings.imageGeneration.videoEnabled === false || (visible.length === 0 && !setting.value)) return null;
  const server = visible.find((m) => m.ref === settings.models.defaults.video) ?? visible[0];
  const named = server ? ` (${server.displayName})` : '';
  const warning = isUnavailable(setting.value, visible) ? `This model is no longer available. Your videos use the server default${named} until you choose another.` : null;
  return (
    <SettingRow id="prefs.models.video" setting={setting} error={warning}>
      {(label) => <ModelSelect {...label} setting={setting} unsetLabel={`Server default${named}`} models={visible} providerNames={providerNames} />}
    </SettingRow>
  );
}

const SOUND_NOUNS: Record<AudioKind, string> = { speech: 'Your speech', music: 'Your music', sound: 'Your sound effects' };

/** The same for each kind of sound: a row only once some model makes it, as most servers have no model for some kinds. */
function DefaultSoundModelRow({ kind }: { kind: AudioKind }) {
  const setting = usePref<string | undefined>(['models', kind]);
  const { data: models = [] } = useImageModels();
  const { settings } = useSettings();
  const providerNames = useMemo(() => new Map(settings?.imageProviders?.map((p) => [p.id, p.name])), [settings?.imageProviders]);
  const visible = models.filter((m) => !m.hidden && makesAudio(m) && !!m.capabilities.audio?.kinds.includes(kind));
  if (!settings?.imageGeneration?.enabled || settings.imageGeneration.audioEnabled === false || (visible.length === 0 && !setting.value)) return null;
  const server = visible.find((m) => m.ref === settings.models.defaults[kind]) ?? visible[0];
  const named = server ? ` (${server.displayName})` : '';
  const warning = isUnavailable(setting.value, visible) ? `This model is no longer available. ${SOUND_NOUNS[kind]} use the server default${named} until you choose another.` : null;
  return (
    <SettingRow id={`prefs.models.${kind}`} setting={setting} error={warning}>
      {(label) => <ModelSelect {...label} setting={setting} unsetLabel={`Server default${named}`} models={visible} providerNames={providerNames} />}
    </SettingRow>
  );
}

function SegmentedRow<K extends keyof Appearance & string>({
  id,
  field,
  items,
  variant,
}: {
  id: SettingId;
  field: K;
  items: SegmentedControlItem<Appearance[K]>[];
  variant?: 'icon';
}) {
  const setting = usePref<Appearance[K]>(['appearance', field]);
  return (
    <SettingRow id={id} setting={setting}>
      {(label) => (
        <SegmentedControl {...label} items={items} variant={variant} value={setting.value} onValueChange={(v) => void setting.set(v)} />
      )}
    </SettingRow>
  );
}
