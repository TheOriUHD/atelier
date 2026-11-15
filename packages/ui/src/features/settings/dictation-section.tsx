/**
 * Settings › General › Dictation (ARCHITECTURE §27): everyone's language, "Hold to record" and this computer's
 * microphone; for admins, whether dictation is on and which speech-to-text service it uses.
 */
import { DICTATION_LANGUAGES } from '@atelier/protocol';
import { Select, Switch } from '../../components/ui/index.ts';
import { useAccount, useDictationStatus } from '../../lib/queries.ts';
import { saveMicrophone, useMicrophones, useSavedMicrophone } from '../dictation/microphones.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { usePref, useSetting } from './use-setting.ts';

const LANGUAGES = [{ value: 'auto', label: 'Auto' }, ...DICTATION_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))];

export function DictationSection() {
  const { data: status } = useDictationStatus();
  const { account } = useAccount();
  const admin = account?.role === 'admin';
  // A server from before dictation answers with an error: nothing to set.
  if (!status || (!status.enabled && !admin)) return null;
  return (
    <SettingsSection title="Dictation">
      {admin && <EnabledRow />}
      {admin && status.enabled && <SourceRow sources={status.sources} chosen={status.chosen} />}
      {status.enabled && (
        <>
          <LanguageRow />
          <HoldRow />
          <MicrophoneRow />
        </>
      )}
    </SettingsSection>
  );
}

function EnabledRow() {
  const setting = useSetting<boolean>(['dictation', 'enabled']);
  return (
    <SettingRow id="dictation.enabled" setting={setting}>
      {(label) => <Switch {...label} checked={setting.value !== false} onCheckedChange={(on) => void setting.set(on)} />}
    </SettingRow>
  );
}

function SourceRow({ sources, chosen }: { sources: readonly { id: string; label: string; provider: string; live: boolean }[]; chosen: string | null }) {
  const setting = useSetting<string | undefined>(['dictation', 'source']);
  const name = (s: (typeof sources)[number]) => `${s.label} · ${s.provider}`;
  if (sources.length === 0)
    return (
      <SettingRow
        id="dictation.source"
        detail="None of the providers here offers speech-to-text yet. Add Mistral (live words as you speak), OpenAI, Groq, ElevenLabs or Deepgram under Providers or Media, or a local Whisper server such as Speaches with a speech-to-text model typed in."
      >
        {null}
      </SettingRow>
    );
  const gone = chosen && !sources.some((s) => s.id === chosen);
  const options = [{ value: 'auto', label: `Automatic (${name(sources[0]!)})` }, ...sources.map((s) => ({ value: s.id, label: `${name(s)}${s.live ? ' · live' : ''}` }))];
  return (
    <SettingRow id="dictation.source" setting={setting} error={gone ? 'The service chosen is no longer set up: dictation uses the automatic choice until you choose another.' : null}>
      {(label) => (
        <Select
          {...label}
          className="max-w-72"
          options={options}
          value={chosen && !gone ? chosen : 'auto'}
          onValueChange={(v) => void (v === 'auto' ? setting.clear() : setting.set(v))}
        />
      )}
    </SettingRow>
  );
}

function LanguageRow() {
  const setting = usePref<string>(['dictation', 'language']);
  return (
    <SettingRow id="prefs.dictation.language" setting={setting}>
      {(label) => <Select {...label} options={LANGUAGES} value={setting.value ?? 'auto'} onValueChange={(v) => void setting.set(v)} />}
    </SettingRow>
  );
}

function HoldRow() {
  const setting = usePref<boolean>(['dictation', 'holdToRecord']);
  return (
    <SettingRow id="prefs.dictation.holdToRecord" setting={setting}>
      {(label) => <Switch {...label} checked={setting.value !== false} onCheckedChange={(on) => void setting.set(on)} />}
    </SettingRow>
  );
}

function MicrophoneRow() {
  const microphones = useMicrophones(null);
  const saved = useSavedMicrophone();
  const unnamed = microphones.list.length > 0 && microphones.list.every((m) => /^Microphone \d+$/.test(m.label));
  const options = [{ value: 'system', label: microphones.defaultLabel ?? 'System default' }, ...microphones.list.map((m) => ({ value: m.id, label: m.label }))];
  const value = saved && microphones.list.some((m) => m.id === saved) ? saved : 'system';
  return (
    <SettingRow id="dictation.microphone" detail={unnamed ? 'Their names show once you have dictated here once.' : undefined}>
      {(label) => <Select {...label} className="max-w-72" options={options} value={value} onValueChange={(v) => saveMicrophone(v === 'system' ? null : v)} />}
    </SettingRow>
  );
}
