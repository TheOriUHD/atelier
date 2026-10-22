import { useMemo, useReducer } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { UserPrefs } from '@atelier/protocol';
import { SegmentedControl, Select, Switch, type SegmentedControlItem } from '../../components/ui/index.ts';
import { useModels, useSettings } from '../../lib/queries.ts';
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
