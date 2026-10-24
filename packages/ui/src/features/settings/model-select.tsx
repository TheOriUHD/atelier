import type { ModelInfo } from '@atelier/protocol';
import { Select, type SelectOption } from '../../components/ui/index.ts';
import type { Setting } from './use-setting.ts';

/** Select value for "no model set"; model refs always contain a slash, so it can't collide. */
const UNSET = 'unset';

/** Whether a model slot points at a model that isn't among the visible ones (removed, hidden, its provider gone). */
export function isUnavailable(ref: string | undefined, visible: readonly ModelInfo[]): boolean {
  return !!ref && !visible.some((m) => m.ref === ref);
}

/** A model slot (a default, an alias or a preference): unset, or one of the visible models. */
export function ModelSelect({
  setting,
  unsetLabel,
  models,
  providerNames,
  'aria-labelledby': labelledBy,
}: {
  setting: Setting<string | undefined>;
  unsetLabel: string;
  models: ModelInfo[];
  providerNames: Map<string, string>;
  'aria-labelledby': string;
}) {
  const byRef = new Map(models.map((m) => [m.ref, m]));
  const options: SelectOption[] = [{ value: UNSET, label: unsetLabel }, ...models.map((m) => ({ value: m.ref, label: m.displayName }))];
  if (setting.value && !byRef.has(setting.value)) options.push({ value: setting.value, label: `${setting.value} (unavailable)` });
  const showProvider = providerNames.size > 1 || models.some((m) => m.personal);
  return (
    <Select
      aria-labelledby={labelledBy}
      className="max-w-80"
      options={options}
      value={setting.value ?? UNSET}
      onValueChange={(v) => void (v === UNSET ? setting.clear() : setting.set(v))}
      renderOption={(o) => {
        const m = byRef.get(o.value);
        return m && showProvider ? (
          <>
            {m.displayName} <span className="text-fg-muted">· {m.personal?.deviceName ?? providerNames.get(m.providerId) ?? m.providerId}</span>
          </>
        ) : (
          o.label
        );
      }}
    />
  );
}
