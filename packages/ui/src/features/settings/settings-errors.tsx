import { TriangleAlert } from 'lucide-react';
import type { SettingsSnapshot } from '@atelier/protocol';
import { Icon } from '../../components/ui/index.ts';

const LAYER_NAMES: Record<SettingsSnapshot['errors'][number]['layer'], string> = {
  global: 'The settings file',
  project: 'This project’s .atelier/settings.json',
  local: 'This project’s .atelier/settings.local.json',
};

/** Problems in the settings files (admins only receive them): what doesn't apply until the file is fixed. */
export function SettingsFileErrors({ errors }: { errors: SettingsSnapshot['errors'] }) {
  if (!errors.length) return null;
  return (
    <div role="alert" className="mb-6 flex gap-2 rounded-lg bg-warning-subtle px-3 py-2.5 text-body text-warning-text">
      <Icon icon={TriangleAlert} className="mt-0.5 shrink-0" />
      <ul className="flex min-w-0 flex-col gap-1">
        {errors.map((e) => (
          <li key={e.layer} className="break-words">
            {LAYER_NAMES[e.layer]} has settings that don’t apply until it is fixed: {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
