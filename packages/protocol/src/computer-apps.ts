/**
 * Which kind of app an app is, for computer use: browsers start view-only (web pages can carry instructions aimed at the
 * model), terminals and IDEs click-only (typing there would run commands outside the permission rules), system apps
 * can never be allowed (security prompts, System Settings, the keychain, Atelier itself), and password managers start
 * on the person's denied list. By bundle id on macOS; on Windows by the lowercase exe name (`chrome.exe`), or a
 * packaged app's package family name (`MSTeams_8wekyb3d8bbwe`), as the Windows helper names apps.
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
    // Atelier run from the bare Electron binary (development).
    'com.github.Electron',
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

const WINDOWS: Record<Exclude<AppCategory, 'other'>, readonly string[]> = {
  browser: [
    'chrome.exe',
    'msedge.exe',
    'firefox.exe',
    'brave.exe',
    'opera.exe',
    'vivaldi.exe',
    'arc.exe',
    'TheBrowserCompany.Arc_ttt1ap7aakyb4',
    'zen.exe',
    'chromium.exe',
    'iexplore.exe',
  ],
  terminal: [
    'windowsterminal.exe',
    'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
    'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe',
    'cmd.exe',
    'powershell.exe',
    'powershell_ise.exe',
    'pwsh.exe',
    'conhost.exe',
    'openconsole.exe',
    'wezterm-gui.exe',
    'alacritty.exe',
    'mintty.exe',
    'hyper.exe',
    'tabby.exe',
    'warp.exe',
    'putty.exe',
    'mobaxterm.exe',
  ],
  ide: [
    'code.exe',
    'code - insiders.exe',
    'cursor.exe',
    'windsurf.exe',
    'devenv.exe',
    'zed.exe',
    'sublime_text.exe',
    'idea64.exe',
    'pycharm64.exe',
    'webstorm64.exe',
    'rider64.exe',
    'clion64.exe',
    'goland64.exe',
    'phpstorm64.exe',
    'rubymine64.exe',
    'datagrip64.exe',
    'studio64.exe',
    'fleet.exe',
  ],
  mail: ['outlook.exe', 'olk.exe', 'Microsoft.OutlookForWindows_8wekyb3d8bbwe', 'microsoft.windowscommunicationsapps_8wekyb3d8bbwe', 'thunderbird.exe', 'mailbird.exe', 'mailclient.exe'],
  messaging: [
    'MSTeams_8wekyb3d8bbwe',
    'ms-teams.exe',
    'teams.exe',
    'slack.exe',
    'discord.exe',
    '5319275A.WhatsAppDesktop_cv1g1gvanyjgm',
    'whatsapp.exe',
    'telegram.exe',
    'TelegramMessengerLLP.TelegramDesktop_t4vj0pshhgkwm',
    'signal.exe',
    'skype.exe',
    'zoom.exe',
  ],
  'password-manager': ['1password.exe', 'bitwarden.exe', '8bitSolutionsLLC.bitwardendesktop_h4e712dmw3xyy', 'keepassxc.exe', 'keepass.exe', 'proton pass.exe', 'enpass.exe'],
  system: [
    'atelier.exe',
    'electron.exe',
    'logonui.exe',
    'consent.exe',
    'credentialuibroker.exe',
    'lockapp.exe',
    'systemsettings.exe',
    'windows.immersivecontrolpanel_cw5n1h2txyewy',
    'Microsoft.SecHealthUI_8wekyb3d8bbwe',
    'taskmgr.exe',
    'regedit.exe',
    'mmc.exe',
    'useraccountcontrolsettings.exe',
    'mstsc.exe',
  ],
};

/**
 * A bundle id ending in `.` matches every id that starts with it (JetBrains' IDEs). Windows names are compared without
 * case: exe names come in either.
 */
const matches = (id: string, known: string) => (known.endsWith('.') ? id.startsWith(known) : id === known || id.toLowerCase() === known.toLowerCase());

export function appCategory(id: string): AppCategory {
  for (const lists of [MAC, WINDOWS]) {
    for (const [category, ids] of Object.entries(lists) as [Exclude<AppCategory, 'other'>, readonly string[]][]) {
      if (ids.some((known) => matches(id, known))) return category;
    }
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

/** The denied list a new person starts with on macOS: the password managers (removable). */
export const SEEDED_DENIED: readonly ComputerApp[] = [
  { id: 'com.1password.1password', name: '1Password' },
  { id: 'com.bitwarden.desktop', name: 'Bitwarden' },
  { id: 'com.apple.Passwords', name: 'Passwords' },
  { id: 'me.proton.pass.electron', name: 'Proton Pass' },
  { id: 'org.keepassxc.keepassxc', name: 'KeePassXC' },
  { id: 'com.dashlane.dashlanephonefinal', name: 'Dashlane' },
];

const SEEDED_DENIED_WINDOWS: readonly ComputerApp[] = [
  { id: '1password.exe', name: '1Password' },
  { id: 'bitwarden.exe', name: 'Bitwarden' },
  { id: '8bitSolutionsLLC.bitwardendesktop_h4e712dmw3xyy', name: 'Bitwarden (Microsoft Store)' },
  { id: 'keepassxc.exe', name: 'KeePassXC' },
  { id: 'keepass.exe', name: 'KeePass' },
  { id: 'proton pass.exe', name: 'Proton Pass' },
  { id: 'enpass.exe', name: 'Enpass' },
];

/** The password managers a new person's denied list starts with, on their system. */
export function seededDenied(platform: string): readonly ComputerApp[] {
  return platform === 'win32' ? SEEDED_DENIED_WINDOWS : SEEDED_DENIED;
}
