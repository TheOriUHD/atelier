/**
 * Which kind of app an app is, for computer use: browsers start view-only (web pages can carry instructions aimed at the
 * model), terminals and IDEs click-only (typing there would run commands outside the permission rules), system apps
 * can never be allowed (security prompts, System Settings, the keychain, Atelier itself), and password managers start
 * on the person's denied list. By bundle id on macOS.
 */
import type { AppCategory, AppTier, ComputerApp } from './computer.ts';

const MAC: Record<Exclude<AppCategory, 'other'>, readonly string[]> = {
  browser: [
    'com.apple.Safari',
    'com.apple.SafariTechnologyPreview',
    'com.google.Chrome',
    'com.google.Chrome.canary',
    'org.chromium.Chromium',
    'org.mozilla.firefox',
    'org.mozilla.firefoxdeveloperedition',
    'com.microsoft.edgemac',
    'com.brave.Browser',
    'company.thebrowser.Browser',
    'company.thebrowser.dia',
    'com.operasoftware.Opera',
    'com.vivaldi.Vivaldi',
    'app.zen-browser.zen',
    'org.torproject.torbrowser',
  ],
  terminal: ['com.apple.Terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'dev.warp.Warp-Stable', 'net.kovidgoyal.kitty', 'org.alacritty', 'io.alacritty', 'co.zeit.hyper', 'com.github.wez.wezterm'],
  ide: ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.todesktop.230313mzl4w4u92', 'com.apple.dt.Xcode', 'dev.zed.Zed', 'com.sublimetext.4', 'com.exafunction.windsurf', 'com.jetbrains.'],
  mail: ['com.apple.mail', 'com.microsoft.Outlook', 'com.readdle.smartemail-Mac', 'com.mimestream.Mimestream', 'org.mozilla.thunderbird', 'com.superhuman.electron', 'com.airmailapp.airmail5'],
  messaging: [
    'com.apple.MobileSMS',
    'com.tinyspeck.slackmacgap',
    'com.hnc.Discord',
    'net.whatsapp.WhatsApp',
    'desktop.WhatsApp',
    'com.microsoft.teams2',
    'ru.keepcoder.Telegram',
    'org.whispersystems.signal-desktop',
    'com.facebook.archon',
  ],
  'password-manager': ['com.1password.1password', 'com.bitwarden.desktop', 'com.apple.Passwords', 'me.proton.pass.electron', 'org.keepassxc.keepassxc', 'com.dashlane.dashlanephonefinal'],
  system: [
    'dev.atelier.app',
    'com.apple.SecurityAgent',
    'com.apple.loginwindow',
    'com.apple.coreautha',
    'com.apple.UserNotificationCenter',
    'com.apple.keychainaccess',
    'com.apple.systempreferences',
    'com.apple.Settings',
    'com.apple.ScreenSharing',
  ],
};

/** A bundle id ending in `.` matches every id that starts with it (JetBrains' IDEs). */
const matches = (id: string, known: string) => (known.endsWith('.') ? id.startsWith(known) : id === known);

export function appCategory(id: string): AppCategory {
  for (const [category, ids] of Object.entries(MAC) as [Exclude<AppCategory, 'other'>, readonly string[]][]) {
    if (ids.some((known) => matches(id, known))) return category;
  }
  return 'other';
}

/** The tier an app gets when allowed, before the person changes it: null where it can never be allowed. */
export function defaultTier(category: AppCategory): AppTier | null {
  if (category === 'system') return null;
  if (category === 'browser') return 'view';
  if (category === 'terminal' || category === 'ide') return 'click';
  return 'full';
}

/** The highest tier the person may give an app: browsers can be upgraded to `full`, terminals and IDEs can't. */
export function maxTier(category: AppCategory): AppTier | null {
  if (category === 'system') return null;
  if (category === 'terminal' || category === 'ide') return 'click';
  return 'full';
}

/** Mail and messaging apps: their links aren't clicked (they lead to wherever a message says). */
export const linkSensitive = (category: AppCategory): boolean => category === 'mail' || category === 'messaging';

/** The denied list a new person starts with: the password managers (removable). */
export const SEEDED_DENIED: readonly ComputerApp[] = [
  { id: 'com.1password.1password', name: '1Password' },
  { id: 'com.bitwarden.desktop', name: 'Bitwarden' },
  { id: 'com.apple.Passwords', name: 'Passwords' },
  { id: 'me.proton.pass.electron', name: 'Proton Pass' },
  { id: 'org.keepassxc.keepassxc', name: 'KeePassXC' },
  { id: 'com.dashlane.dashlanephonefinal', name: 'Dashlane' },
];
