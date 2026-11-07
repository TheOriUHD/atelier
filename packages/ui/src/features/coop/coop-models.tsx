/**
 * Co-op models (design/components.md › Co-op): whose models a person may name for one answer (an @mention, a second
 * opinion) and for all their messages, in two groups, "Ada’s models" and "Your models". The host's are the host's to
 * pay for, within the guest's daily share; a guest's own are theirs, and only where the host agreed to send the session
 * to them (`allowGuestModels`).
 */
import { ChevronDown, Split } from 'lucide-react';
import { answerWithValue, parseAnswerWith, type ModelInfo } from '@atelier/protocol';
import { Icon, IconButton, Menu, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../../components/ui/index.ts';
import { useModels } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { modelSubtitle } from '../chat/models.ts';
import { possessive, reportError, sharedUseLine, useCoopActions, useCoopView, type CoopView } from './coop.ts';

/** One model a person may name: `value` is `host:<ref>` or `own:<ref>`. */
export interface AnswerModel {
  value: string;
  label: string;
  description: string;
  /** "Ada’s models" or "Your models" (or "Models" for the host), for a flat list. */
  group: string;
  disabled: boolean;
}

export interface AnswerGroup {
  source: 'host' | 'own';
  label: string;
  /** Why the group can't be used, shown in place of its models' subtitles. */
  note: string | null;
  models: AnswerModel[];
}

const visible = (m: ModelInfo) => !m.hidden && m.available !== false;

/**
 * The models the viewer may name for one answer. The host names any of theirs. A guest names the host's while the host
 * shares them (on a server, the server's own models; across computers the host's list isn't known here, so none), and
 * their own, greyed out with the reason while the host hasn't agreed to them.
 */
export function useAnswerModels(coop: CoopView): AnswerGroup[] {
  const { data: models = [] } = useModels();
  if (!coop.shared || coop.ended || coop.role === 'viewer') return [];
  const shown = models.filter(visible);
  const item = (source: 'host' | 'own', group: string, disabled: boolean) => (m: ModelInfo): AnswerModel => ({ value: answerWithValue({ source, ref: m.ref }), label: m.displayName, description: modelSubtitle(m), group, disabled });
  if (coop.isHost) return [{ source: 'host', label: 'Models', note: null, models: shown.map(item('host', 'Models', false)) }];
  const settings = coop.state?.settings;
  const groups: AnswerGroup[] = [];
  if (settings?.shareModels) {
    const label = `${possessive(coop.hostName)} models`;
    // The host's backend says which it shares (on a guest's own computer too); an older one doesn't, and on a server
    // they are the server's own models.
    const listed = coop.state?.hostModels;
    const theirs: AnswerModel[] = listed
      ? listed.map((m) => {
          const known = models.find((k) => k.ref === m.ref);
          return { value: answerWithValue({ source: 'host', ref: m.ref }), label: m.displayName, description: known ? modelSubtitle(known) : `${coop.hostName} pays for it`, group: label, disabled: false };
        })
      : coop.state?.via === 'server'
        ? shown.filter((m) => !m.personal).map(item('host', label, false))
        : [];
    groups.push({ source: 'host', label, note: theirs.length ? null : `${coop.hostName}’s list isn’t shown on this computer.`, models: theirs });
  }
  const agreed = settings?.allowGuestModels !== false;
  groups.push({ source: 'own', label: 'Your models', note: agreed ? null : `${coop.hostName} hasn’t agreed to send this session to guests’ own models.`, models: shown.map(item('own', 'Your models', !agreed)) });
  return groups;
}

/**
 * "GPT-6" for an answer-with value (or a bare ref): from the viewer's list when it has the model, else the host's shared
 * list, else its id.
 */
export function answerWithName(value: string, models: readonly ModelInfo[] | undefined, hostModels?: readonly { ref: string; displayName: string }[]): string {
  const ref = parseAnswerWith(value)?.ref ?? value;
  return models?.find((m) => m.ref === ref)?.displayName ?? hostModels?.find((m) => m.ref === ref)?.displayName ?? ref.slice(ref.indexOf('/') + 1);
}

/** The menu's groups: a label each, a separator between, a group that can't be used says why. */
function GroupedItems({ groups, onPick }: { groups: AnswerGroup[]; onPick(value: string): void }) {
  return (
    <>
      {groups.map((g, i) => (
        <MenuGroup key={g.source}>
          {i > 0 && <MenuSeparator />}
          <MenuLabel>{g.label}</MenuLabel>
          {g.models.length === 0 && g.note && <p className="px-2.5 pb-1.5 text-footnote text-fg-muted">{g.note}</p>}
          {g.models.map((m) => (
            <MenuItem key={m.value} disabled={m.disabled} description={m.disabled && g.note ? g.note : m.description} onClick={() => onPick(m.value)}>
              {m.label}
            </MenuItem>
          ))}
        </MenuGroup>
      ))}
    </>
  );
}

/** A reply's "Second opinion": the same question answered again by another model the person may use, as a sibling. */
export function SecondOpinion({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const coop = useCoopView();
  const groups = useAnswerModels(coop);
  if (!groups.some((g) => g.models.length > 0)) return null;
  return (
    <Menu>
      <MenuTrigger render={<IconButton icon={Split} label="Second opinion" size="xs" />} />
      <MenuContent align="start" className="w-[295px]">
        <GroupedItems groups={groups} onPick={(model) => void rpc().call('chat.secondOpinion', { sessionId, messageId, model }).catch((e: unknown) => reportError(sessionId, e))} />
      </MenuContent>
    </Menu>
  );
}

/**
 * A guest's model control in the footer, in place of the session's model picker (which is the host's): "Ada’s models"
 * first while the host shares them (the session's model answers), then the guest's own models, greyed out with the
 * reason while the host hasn't agreed to them.
 */
export function CoopModelChip({ coop, open, onOpenChange }: { coop: CoopView; open?: boolean; onOpenChange?(open: boolean): void }) {
  const actions = useCoopActions(coop.sessionId ?? '');
  const { data: models = [] } = useModels();
  const me = coop.people.find((p) => p.id === coop.me);
  const state = coop.state;
  if (!state || !me) return null;
  const shared = state.settings.shareModels;
  const agreed = state.settings.allowGuestModels;
  const host = me.models === 'host' && shared;
  const own = host ? undefined : models.find((m) => m.ref === me.model);
  const hostModels = `${possessive(coop.hostName)} models`;
  const label = host ? hostModels : (own?.displayName ?? 'Choose a model');
  const choose = (value: string) => {
    const next = value === 'host' ? { models: 'host' as const, model: null } : { models: 'own' as const, model: value };
    void actions.models(next.models, next.model).catch((e: unknown) => reportError(coop.sessionId, e));
  };
  return (
    <Menu {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <MenuTrigger
        aria-label={`Answer my messages with: ${host ? hostModels : (own?.displayName ?? 'no model chosen')}`}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-2 text-control-sm outline-none focus-ring hover:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover"
      >
        <span className="max-w-56 truncate text-fg">{label}</span>
        <Icon icon={ChevronDown} size="sm" className="size-3 text-fg-muted" />
      </MenuTrigger>
      <MenuContent align="end" className="w-[295px]">
        <MenuRadioGroup value={host ? 'host' : (own?.ref ?? '')} onValueChange={choose}>
          {shared && (
            <>
              <MenuLabel>{hostModels}</MenuLabel>
              <MenuRadioItem value="host" description={sharedUseLine(state) ?? `The session’s model. ${coop.hostName} pays for it.`}>
                {hostModels}
              </MenuRadioItem>
              <MenuSeparator />
            </>
          )}
          <MenuLabel>Your models</MenuLabel>
          {models.filter(visible).map((m) => (
            <MenuRadioItem key={m.ref} value={m.ref} disabled={!agreed && m.ref !== own?.ref} description={agreed ? modelSubtitle(m) : `${coop.hostName} hasn’t agreed to guests’ own models`}>
              {m.displayName}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
