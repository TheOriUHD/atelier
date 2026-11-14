/**
 * Settings › Help & feedback: reporting an issue or asking for a feature (ARCHITECTURE §26), the documentation, and
 * Copy diagnostics for a report elsewhere. An admin can turn reports off for everyone here.
 */
import { BookOpen, Bug, Lightbulb } from 'lucide-react';
import { Button, Switch } from '../../components/ui/index.ts';
import { CopyDiagnosticsButton } from '../../app/copy-diagnostics-button.tsx';
import { useCloseSettings } from '../../app/navigation.ts';
import { openExternal } from '../../lib/platform.ts';
import { keys, queryClient, useAccount } from '../../lib/queries.ts';
import { shortcutText, useShortcutBindings } from '../../lib/shortcuts.ts';
import { openReporter } from '../reports/open-report.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useSetting } from './use-setting.ts';

export function HelpPage() {
  const { account } = useAccount();
  const admin = account?.role === 'admin';
  const allowed = useSetting<boolean>(['reports', 'enabled']);
  const close = useCloseSettings();
  const shortcuts = useShortcutBindings();
  // The report opens over the app, not over Settings.
  const report = (kind: 'issue' | 'feature') => {
    close();
    void openReporter(kind);
  };
  return (
    <>
      <SettingsSection title="Feedback">
        <SettingRow id="help.reportIssue">
          <Button leadingIcon={Bug} onClick={() => report('issue')}>
            Report an issue{shortcuts['report-issue'] ? ` (${shortcutText(shortcuts['report-issue'])})` : ''}
          </Button>
        </SettingRow>
        <SettingRow id="help.requestFeature">
          <Button leadingIcon={Lightbulb} onClick={() => report('feature')}>
            Request a feature
          </Button>
        </SettingRow>
        {admin && (
          <SettingRow id="help.reportsAllowed" setting={allowed}>
            {(label) => (
              <Switch
                {...label}
                checked={allowed.value ?? true}
                onCheckedChange={(v) => void allowed.set(v).then(() => queryClient.invalidateQueries({ queryKey: keys.appInfo }))}
              />
            )}
          </SettingRow>
        )}
      </SettingsSection>
      <SettingsSection title="Help">
        <SettingRow id="help.docs">
          <Button leadingIcon={BookOpen} onClick={() => openExternal('https://docs.atelierhq.dev/')}>
            Open
          </Button>
        </SettingRow>
        <SettingRow id="help.diagnostics">
          <CopyDiagnosticsButton />
        </SettingRow>
      </SettingsSection>
    </>
  );
}
