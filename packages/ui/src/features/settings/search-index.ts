/**
 * Every addressable row in Settings. Rows render their label and description from here, so the
 * search results and the page can't drift apart. `id` is the `?row=` value and the row's
 * `data-setting-row` attribute.
 */
import { ULTRACODE_MAX_SUBAGENTS } from '@atelier/protocol';
import { passkeysAvailable } from '../auth/passkeys.ts';
import { identityProvidersOffered } from '../auth/sign-in.ts';
import { desktop, isMac } from '../../lib/platform.ts';
import { audioGenerationOffered, auditLogOffered, imageGenerationOffered, usageLimitsOffered, videoGenerationOffered } from '../../lib/queries.ts';
import { isLocal } from '../auth/screen-lock.ts';
import { SETTINGS_PAGES, visiblePages, type SettingsPageId } from './pages.ts';

export interface SettingEntry {
  id: string;
  page: SettingsPageId;
  label: string;
  description?: string;
  keywords?: readonly string[];
  /** Shown to admins only, on a page everyone has. */
  admin?: boolean;
  /** Shown only where it works (passkeys need a browser with WebAuthn). */
  available?(): boolean;
}

const ALIAS_KEYWORDS = ['alias', 'claude code', 'agent', 'skill', 'frontmatter'];

export const SETTINGS_INDEX = [
  {
    id: 'appearance.theme',
    page: 'general',
    label: 'Theme',
    keywords: ['dark mode', 'light mode', 'color scheme', 'appearance'],
  },
  {
    id: 'appearance.chatFont',
    page: 'general',
    label: 'Chat font',
    keywords: ['typeface', 'serif', 'sans', 'system', 'dyslexic', 'opendyslexic', 'appearance'],
  },
  {
    id: 'appearance.textSize',
    page: 'general',
    label: 'Transcript text size',
    description: 'Size of the conversation transcript text.',
    keywords: ['font size', 'zoom', 'small', 'medium', 'large', 'appearance'],
  },
  {
    id: 'appearance.transcriptWidth',
    page: 'general',
    label: 'Transcript width',
    description: 'Maximum width of the transcript and composer columns.',
    keywords: ['column', 'narrow', 'wide', 'layout', 'appearance'],
  },
  {
    id: 'appearance.motion',
    page: 'general',
    label: 'Motion',
    description: 'Reduce animation in streaming responses and other interface elements.',
    keywords: ['animation', 'reduced motion', 'accessibility', 'appearance'],
  },
  {
    id: 'prefs.models.chat',
    page: 'general',
    label: 'Default model',
    description: 'New chats start with this model. “Server default” follows the one set for everyone.',
    keywords: ['default chat model', 'chat', 'model picker', 'server default'],
  },
  {
    id: 'prefs.models.rememberLast',
    page: 'general',
    label: 'Start with the model I used last',
    description: 'The model you pick in a conversation is the one the next new conversation starts with. Turn it off to always start with the one chosen above.',
    keywords: ['remember', 'last used', 'new conversation'],
  },
  {
    id: 'prefs.models.image',
    page: 'general',
    label: 'Default image model',
    description: 'What makes your images, unless you pick another in a conversation or name one when you ask.',
    keywords: ['image generation', 'pictures', 'comfyui', 'server default'],
    available: () => imageGenerationOffered(),
  },
  {
    id: 'prefs.models.video',
    page: 'general',
    label: 'Default video model',
    description: 'What makes your videos, unless you name another when you ask. A model that makes video from a picture only needs one to start from.',
    keywords: ['video generation', 'clips', 'animation', 'server default'],
    available: () => videoGenerationOffered(),
  },
  {
    id: 'prefs.models.speech',
    page: 'general',
    label: 'Default speech model',
    description: 'What reads text aloud for you, unless you name another when you ask. Each model has its own voices.',
    keywords: ['text to speech', 'tts', 'voice', 'read aloud', 'narration', 'server default'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'prefs.models.music',
    page: 'general',
    label: 'Default music model',
    description: 'What makes your songs and background music, unless you name another when you ask.',
    keywords: ['music generation', 'songs', 'lyrics', 'instrumental', 'server default'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'prefs.models.sound',
    page: 'general',
    label: 'Default sound effects model',
    description: 'What makes your sound effects and ambience, unless you name another when you ask.',
    keywords: ['sound effects', 'sfx', 'foley', 'ambience', 'server default'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'notifications.taskFinished',
    page: 'general',
    label: 'Notify me when a task finishes',
    description: 'A system notification when a chat’s task ends while you’re in another window or app.',
    keywords: ['notifications', 'alert', 'done', 'work', 'background'],
  },
  {
    id: 'notifications.permissionNeeded',
    page: 'general',
    label: 'Notify me when a task needs me',
    description: 'A system notification when a chat’s task waits for your answer or permission.',
    keywords: ['notifications', 'alert', 'permission', 'question', 'input', 'work'],
  },
  {
    id: 'shortcuts.app',
    page: 'shortcuts',
    label: 'App shortcuts',
    description: 'New chat, search, Settings, the sidebar and the screen lock. Change the keys or turn one off.',
    keywords: ['keyboard', 'hotkey', 'keybinding', 'rebind', 'key', 'new chat', 'temporary chat', 'search', 'command palette', 'sidebar', 'lock'],
  },
  {
    id: 'shortcuts.messageBox',
    page: 'shortcuts',
    label: 'Message box shortcuts',
    description: 'Upload or add files and change effort. Send, new line, stop, / and @ always work the same.',
    keywords: ['keyboard', 'hotkey', 'keybinding', 'rebind', 'key', 'upload', 'attach', 'effort', 'composer'],
  },
  {
    id: 'profile.avatar',
    page: 'account',
    label: 'Profile photo',
    description: 'PNG, JPEG, GIF or WebP, up to 5 MB.',
    keywords: ['avatar', 'picture', 'image', 'profile'],
  },
  {
    id: 'profile.name',
    page: 'account',
    label: 'Full name',
    description: 'Shown in the sidebar and to admins.',
    keywords: ['profile', 'display name'],
  },
  {
    id: 'profile.callMe',
    page: 'account',
    label: 'What should Atelier call you?',
    description: 'Used in the greeting and shared with the model. Your full name is used when this is empty.',
    keywords: ['profile', 'nickname', 'greeting', 'call me'],
  },
  {
    id: 'personalization.instructions',
    page: 'account',
    label: 'Instructions',
    description: 'Preferences the model should keep in mind. They are added to the system prompt of every new chat.',
    keywords: ['custom instructions', 'system prompt', 'preferences', 'about me', 'personalization'],
  },
  {
    id: 'personalization.atelierMd',
    page: 'account',
    label: 'Your ATELIER.md',
    description:
      'Your own conventions and preferences for Code sessions and chats working in a folder, in Markdown. Every new one and its sub-agents read them; where a project’s ATELIER.md disagrees, yours win.',
    keywords: ['atelier.md', 'personal instructions', 'instruction file', 'conventions', 'memory', 'code'],
  },
  {
    id: 'remoteControl',
    page: 'account',
    label: 'Remote control',
    description: 'Access your server sessions from other browsers and devices signed in to this account. Turning this off keeps sessions on their originating device, even when that session allows it.',
    keywords: ['remote', 'control', 'devices', 'sessions', 'privacy'],
  },
  {
    id: 'personalization.personality',
    page: 'account',
    label: 'Personality',
    description:
      'Atelier, Technical, Relaxed or your own custom mode. Style only, not model identity. Applies to new conversations; response style stays independent.',
    keywords: ['personality', 'presets', 'custom modes', 'tone', 'emoji', 'technical', 'relaxed', 'personalization'],
  },
  {
    id: 'personalization.responseStyle',
    page: 'account',
    label: 'Response style',
    description: 'How replies are written unless a chat asks otherwise.',
    keywords: ['tone', 'concise', 'explanatory', 'formal', 'personalization'],
  },
  {
    id: 'connection.mode',
    page: 'connection',
    label: 'Where Atelier runs',
    description: 'On this computer, or on an Atelier server you sign in to. Switching deletes nothing: switch back any time.',
    keywords: ['standalone', 'server mode', 'this computer', 'run on this computer', 'switch', 'change setup', 'set up again', 'setup', 'connect', 'server address', 'server url', 'mode', 'local'],
    available: () => !!desktop?.connection,
  },
  {
    id: 'connection.share',
    page: 'connection',
    label: 'Share on your network',
    description: 'Other devices on your network open Atelier on this computer in a browser or the Atelier app, and sign in as you with a password. They work in your chats, with your models and in your folders.',
    keywords: ['hybrid', 'lan', 'local network', 'other devices', 'phone', 'tablet', 'host', 'serve', 'open to network', 'remote access', 'port'],
    available: () => isLocal() && !!desktop?.connection,
  },
  {
    id: 'connection.shareSwitch',
    page: 'connection',
    label: 'Let other devices use Atelier here',
    description: 'Asks for a password and a port, then other devices on your network can sign in. Off signs them out.',
    keywords: ['share', 'network', 'lan', 'turn on'],
    available: () => isLocal() && !!desktop?.connection,
  },
  {
    id: 'account.username',
    page: 'account',
    label: 'Username',
    description: 'What you sign in with.',
    keywords: ['login', 'user name'],
    // On this computer there is no sign-in, only the screen lock.
    available: () => !isLocal(),
  },
  {
    id: 'account.password',
    page: 'account',
    label: 'Password',
    description: 'Changing it signs you out on your other devices.',
    keywords: ['change password', 'security', 'login'],
    available: () => !isLocal(),
  },
  {
    id: 'account.signOut',
    page: 'account',
    label: 'Log out',
    description: 'Ends your sign-in here.',
    keywords: ['log out', 'logout', 'sign off', 'leave'],
    available: () => !isLocal(),
  },
  {
    id: 'account.logoutEverywhere',
    page: 'account',
    label: 'Log out of all devices',
    description: 'Ends every sign-in to your account, including this one.',
    keywords: ['sign out', 'sessions', 'security'],
    available: () => !isLocal(),
  },
  {
    id: 'account.safeguards',
    page: 'account',
    label: 'Content safeguards',
    description: 'Extra limits on what models write for you. Your administrator manages them.',
    // The row shows only while safeguards apply to the person, so search never leads to it.
    available: () => false,
  },
  {
    id: 'account.sessions',
    page: 'account',
    label: 'Active sessions',
    description: 'Browsers and apps signed in to your account.',
    keywords: ['sign out', 'revoke', 'logins', 'security'],
    available: () => !isLocal(),
  },
  {
    id: 'account.devices',
    page: 'account',
    label: 'Devices',
    description:
      'Computers running the Atelier app for your account. They lend their files and tools to your sessions.',
    keywords: ['this computer', 'desktop', 'machines'],
    available: () => !isLocal(),
  },
  {
    id: 'account.screenLock',
    page: 'account',
    label: 'Screen lock',
    description:
      'Hides Atelier until you enter your PIN or password. Your data on this computer is not encrypted by it.',
    keywords: ['pin', 'password', 'lock', 'security', 'privacy', 'touch id'],
    available: isLocal,
  },
  {
    id: 'account.lockSecret',
    page: 'account',
    label: 'PIN or password',
    description: 'Asked for when Atelier starts and whenever you lock it.',
    keywords: ['screen lock', 'pin', 'change pin', 'lock now', 'security'],
    available: isLocal,
  },
  {
    id: 'account.autoLock',
    page: 'account',
    label: 'Lock when inactive',
    description: 'Locks Atelier after this long without typing or clicking in any of its windows.',
    keywords: ['auto-lock', 'idle', 'timeout', 'away', 'security'],
    available: isLocal,
  },
  {
    id: 'account.passkeys',
    page: 'account',
    label: 'Passkeys',
    description: 'Sign in to this site with your device’s screen lock or a security key instead of your password.',
    keywords: ['webauthn', 'security key', 'touch id', 'face id', 'windows hello', 'fingerprint', 'login', 'security'],
    available: passkeysAvailable,
  },
  {
    id: 'account.identities',
    page: 'account',
    label: 'Connected sign-ins',
    description: 'Other sign-ins for this account in a browser, such as Authentik or Google.',
    keywords: ['sso', 'single sign-on', 'oidc', 'openid connect', 'authentik', 'keycloak', 'login', 'connect'],
    available: identityProvidersOffered,
  },
  {
    id: 'privacy.retention',
    page: 'privacy',
    label: 'Keep conversations',
    description: 'Conversations untouched for longer than this are deleted once a day. Pinned ones stay.',
    keywords: ['history', 'retention', 'auto-delete', 'old chats', 'days'],
  },
  {
    id: 'privacy.temporaryChats',
    page: 'privacy',
    label: 'Temporary chats',
    description:
      'Temporary chats never appear in your history and are deleted when you leave them. Starting fresh also keeps your memory, personal instructions and projects away from the model.',
    keywords: ['incognito', 'private', 'temporary', 'memory', 'fresh', 'ghost'],
  },
  {
    id: 'privacy.export',
    page: 'privacy',
    label: 'Export your data',
    description: 'A zip with all your conversations (as JSON and Markdown), projects, artifacts, files and memory.',
    keywords: ['download', 'backup', 'zip', 'archive', 'takeout'],
  },
  {
    id: 'privacy.deleteConversations',
    page: 'privacy',
    label: 'Delete all conversations',
    description:
      'Every chat and Code session, with its messages, files and artifacts. Projects stay. This can’t be undone.',
    keywords: ['erase', 'wipe', 'clear history', 'remove chats', 'sessions'],
  },
  {
    id: 'usage.overview',
    page: 'usage',
    label: 'Your usage',
    description: 'Requests, tokens, images and cost of your chats and Code sessions.',
    keywords: ['tokens', 'requests', 'cost', 'spend', 'statistics', 'dollars', 'everyone', 'images'],
  },
  {
    id: 'usage.byDay',
    page: 'usage',
    label: 'Tokens by day',
    keywords: ['chart', 'daily', 'history', 'mode', 'chat', 'work', 'code'],
  },
  {
    id: 'usage.byModel',
    page: 'usage',
    label: 'By model',
    description: 'Tokens, cost and average output speed of each model.',
    keywords: ['models', 'tokens per second', 'speed', 'throughput'],
  },
  {
    id: 'usage.images',
    page: 'usage',
    label: 'Images',
    description: 'Images each model made and what they cost. A cost marked “estimate” comes from a price list, because the service didn’t report one.',
    keywords: ['image generation', 'pictures', 'cost', 'estimate', 'models'],
    available: () => imageGenerationOffered(),
  },
  {
    id: 'usage.limits',
    page: 'usage',
    label: 'Your limits',
    description:
      'What an admin lets you use, and how much of it you have used. Tokens, cost and requests count across all of your chats and Code sessions, including deleted ones. A cost limit counts only requests to models with a price.',
    keywords: ['limit', 'quota', 'cap', 'budget', 'tokens', 'requests', 'cost', 'near limit', 'reset'],
    available: () => usageLimitsOffered(),
  },
  {
    id: 'usage.people',
    page: 'usage',
    label: 'Limits by person',
    description: 'Everyone’s usage against their limits, with who is near or at one. Edit a person’s limits here or under Admin › Limits.',
    keywords: ['limit', 'quota', 'near limit', 'everyone', 'accounts', 'exempt'],
    admin: true,
    available: () => usageLimitsOffered(),
  },
  {
    id: 'usage.videos',
    page: 'usage',
    label: 'Videos',
    description: 'Videos each model made, how many seconds of video that is and what it cost. A cost marked “estimate” comes from a price list, because the service didn’t report one.',
    keywords: ['video generation', 'clips', 'seconds', 'cost', 'estimate', 'models'],
    available: () => videoGenerationOffered(),
  },
  {
    id: 'usage.audio',
    page: 'usage',
    label: 'Sounds',
    description: 'Speech, music and sound effects each model made, how long they are in all, the characters read out and what it cost. A cost marked “estimate” comes from a price list, because the service didn’t report one.',
    keywords: ['audio generation', 'speech', 'tts', 'music', 'sound effects', 'characters', 'seconds', 'cost', 'estimate', 'models'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'usage.prices',
    page: 'usage',
    label: 'Prices',
    description:
      'Dollars per million tokens, per model, in place of the provider’s list price (Anthropic, OpenAI and Mistral models without one here use it). A price counts for requests made after it is set.',
    keywords: ['pricing', 'price table', 'cost', 'dollars', 'cache'],
    admin: true,
  },
  {
    id: 'prefs.permissions.allow',
    page: 'code',
    label: 'Always-allowed actions',
    description:
      'What you approved with “Always allow” in a permission prompt. These rules apply in your Code sessions and chats, on top of the rules your admin set.',
    keywords: ['permissions', 'rules', 'always allow', 'approve', 'bash', 'claude code', 'connector', 'chat'],
  },
  {
    id: 'code.explainChanges',
    page: 'code',
    label: 'Explain each change',
    description:
      'Before each edit, Atelier says why in one short sentence, and a permission prompt shows it under the title. Every edit uses a few more tokens, whether a prompt shows or not. New sessions pick this up; a running one keeps what it started with.',
    keywords: ['reason', 'justification', 'why', 'rationale', 'permission', 'edit', 'write', 'tokens'],
  },
  {
    id: 'code.syntaxTheme',
    page: 'code',
    label: 'Code appearance',
    description: 'Syntax highlighting for code: one theme for the light app theme, one for the dark.',
    keywords: ['syntax theme', 'highlighting', 'colors', 'diff', 'shiki'],
  },
  {
    id: 'code.transcriptView',
    page: 'code',
    label: 'Default transcript view',
    description:
      'How Code sessions open: tool calls as usual, with thinking expanded, or with every call’s details expanded. Each session can switch in its header.',
    keywords: ['verbose', 'thinking', 'expand', 'details', 'tool calls', 'appearance'],
  },
  {
    id: 'code.suggestions',
    page: 'code',
    label: 'Suggested replies',
    description:
      'After a reply in Code or a chat’s task, a short guess at your next message shows in the message box; Tab puts it in, typing sets it aside. The small model (or the conversation’s) writes it from your recent messages and the reply.',
    keywords: ['suggestion', 'autocomplete', 'tab', 'next message', 'prompt suggestion'],
  },
  {
    id: 'code.font',
    page: 'code',
    label: 'Code font',
    description: 'A monospace font installed on your computer, for code and diffs.',
    keywords: ['typeface', 'monospace', 'mono', 'appearance'],
  },
  {
    id: 'git.authorName',
    page: 'code',
    label: 'Commit author name',
    description: 'Used for commits you make from the Code view. Empty uses the repository’s git config.',
    keywords: ['git', 'user.name', 'identity', 'commit'],
  },
  {
    id: 'git.authorEmail',
    page: 'code',
    label: 'Commit author email',
    description: 'Used for commits you make from the Code view. Empty uses the repository’s git config.',
    keywords: ['git', 'user.email', 'identity', 'commit'],
  },
  {
    id: 'appearance.interfaceFont',
    page: 'code',
    label: 'Interface font',
    description: 'Font for menus, the sidebar and panels.',
    keywords: ['typeface', 'ui font', 'sans', 'system', 'dyslexic', 'opendyslexic', 'appearance'],
  },
  {
    id: 'folders.list',
    page: 'folders',
    label: 'Folders',
    description:
      'Folders you opened for Code sessions. Their tools run on the computer the folder is on, and can run any command there as you.',
    keywords: [
      'workspaces',
      'projects',
      'repositories',
      'directories',
      'trusted folders',
      'open folder',
      'ssh',
      'remote',
      'devices',
    ],
  },
  {
    id: 'folders.ssh',
    page: 'folders',
    label: 'SSH connections',
    description:
      'Remote machines you work on over SSH: their host, port and key, and whether Atelier keeps a password for them.',
    keywords: ['ssh', 'remote', 'host', 'password', 'known_hosts', 'key', 'server', 'connection'],
  },
  {
    id: 'cloud.github',
    page: 'cloud',
    label: 'GitHub',
    description:
      'Codespaces run on your GitHub account. Atelier keeps its token encrypted and uses it only for Codespaces.',
    keywords: ['connect', 'sign in', 'account', 'personal access token', 'pat', 'device code', 'disconnect'],
  },
  {
    id: 'cloud.github.clientId',
    page: 'cloud',
    label: 'GitHub OAuth app',
    description:
      'The client id of an OAuth app with device flow enabled, so people can sign in with GitHub. Without one, they connect with a personal access token.',
    keywords: ['client id', 'device flow', 'oauth', 'sign in with github'],
    admin: true,
  },
  {
    id: 'cloud.codespaces',
    page: 'cloud',
    label: 'Codespaces',
    description:
      'Cloud machines on GitHub for Code sessions. Each one stops after its idle timeout and runs at most 12 hours at a time.',
    keywords: ['cloud', 'remote', 'machine', 'devcontainer', 'idle timeout', 'workspace', 'folders', 'repository'],
  },
  {
    id: 'skills.list',
    page: 'skills',
    label: 'Skills',
    description:
      'Instructions and scripts that sessions load when a task needs them, or that you start with /name. They come from the folder a session works in, from the skills installed for everyone, and from plugins.',
    keywords: ['slash commands', 'agent skills', 'skill.md', 'claude code', 'npx skills', 'plugin', 'project'],
  },
  {
    id: 'skills.install',
    page: 'skills',
    label: 'Install from GitHub',
    description:
      'A repository or a folder in one: owner/repo, owner/repo@ref/path or a github.com URL. Skills installed with other tools, like npx skills, show up here by themselves; remove those with the tool that installed them.',
    keywords: ['add skill', 'skills', 'github', 'repository', 'download', 'npx skills', 'replace'],
    admin: true,
  },
  { id: 'system.version', page: 'system', label: 'Version', keywords: ['about', 'release', 'build', 'desktop app', 'copyright', 'author'] },
  {
    id: 'system.updates',
    page: 'system',
    label: 'Updates',
    keywords: ['update', 'upgrade', 'new version', 'auto-update', 'check', 'download', 'restart', 'install'],
  },
  {
    id: 'system.autoUpdate',
    page: 'system',
    label: 'Check for updates automatically',
    description: 'Atelier asks for the newest version when it starts and every 5 minutes. Off: it only looks when you press Check now.',
    keywords: ['auto-update', 'automatic', 'privacy', 'network', 'offline'],
  },
  {
    id: 'system.updateChannel',
    page: 'system',
    label: 'Update channel',
    description: 'Beta gets new versions before they’re released as stable.',
    keywords: ['beta', 'stable', 'prerelease', 'early access', 'updates'],
  },
  {
    id: 'system.launchAtLogin',
    page: 'system',
    label: 'Launch at login',
    description: 'Open Atelier when you sign in to this computer.',
    keywords: ['startup', 'start automatically', 'autostart', 'login item', 'open at login', 'boot'],
  },
  {
    id: 'system.computerUse',
    page: 'computer',
    label: 'Enable computer use',
    description: 'Let the assistant in chats and Code see and use the apps you allow on this computer.',
    keywords: ['computer use', 'control', 'mouse', 'keyboard', 'screen', 'apps', 'automation', 'agent'],
    available: () => !!desktop?.computer,
  },
  {
    id: 'system.computerUnhide',
    page: 'computer',
    label: 'Unhide apps when Atelier finishes',
    description: 'Apps hidden while Atelier had full control of your screen come back when it stops.',
    keywords: ['computer use', 'hide', 'unhide', 'apps', 'full control'],
    available: () => !!desktop?.computer,
  },
  {
    id: 'system.computerMode',
    page: 'computer',
    label: 'How Atelier uses the apps you allow',
    description:
      'Background: works in one app at a time in the background, without your mouse and keyboard, while you keep working. Apps you name yourself are allowed without asking; others ask first. Lists to choose from, right clicks, dragging, or an app that ignores background input need full control, which Atelier asks you for. On Linux this is “Ask per app”: you allow apps one by one and Atelier asks before it takes over your mouse and keyboard. Full control: takes over your computer as it is, any app but your denied ones, without asking.',
    keywords: ['computer use', 'background', 'ask per app', 'full control', 'mouse', 'keyboard', 'mode'],
    available: () => !!desktop?.computer,
  },
  {
    id: 'system.computerDenied',
    page: 'computer',
    label: 'Denied apps',
    description: 'Atelier never uses these apps: asking for them is turned down without a question.',
    keywords: ['computer use', 'deny', 'block', 'password manager', 'apps'],
    available: () => !!desktop?.computer,
  },
  {
    id: 'system.computerAlways',
    page: 'computer',
    label: 'Apps allowed for good',
    description: 'Apps you allowed with “Always allow on this computer”; every session may use them.',
    keywords: ['computer use', 'allow', 'always', 'apps'],
    available: () => !!desktop?.computer,
  },
  {
    id: 'system.computerAccessibility',
    page: 'computer',
    label: 'Accessibility',
    description: 'macOS lets Atelier use the mouse and keyboard, and read what is under them, with this permission.',
    keywords: ['computer use', 'permission', 'privacy', 'mouse', 'keyboard', 'system settings'],
    available: () => !!desktop?.computer && isMac,
  },
  {
    id: 'system.computerBrowser',
    page: 'computer',
    label: 'Atelier for Chrome',
    description:
      'The browser extension through which Atelier works in web pages, in tabs of its own in an “Atelier” group, in the background: it reads pages instead of looking at them, and never uses your own tabs. Works in Chrome, Brave, Edge and Arc. Chrome shows “started debugging this browser” while it acts in a page.',
    keywords: ['computer use', 'browser', 'chrome', 'brave', 'edge', 'arc', 'extension', 'web pages', 'tabs'],
    available: () => !!desktop?.browserExtension,
  },
  {
    id: 'system.computerScreen',
    page: 'computer',
    label: 'Screen recording',
    description: 'macOS lets Atelier take screenshots of the apps you allow with this permission. macOS asks again from time to time.',
    keywords: ['computer use', 'permission', 'privacy', 'screenshot', 'screen recording', 'system settings'],
    available: () => !!desktop?.computer && isMac,
  },
  {
    id: 'system.lendScratch',
    page: 'system',
    label: 'Folders for sessions without one',
    description: 'The server can make a new, empty folder on this computer for each session you start without a folder.',
    keywords: ['no folder', 'scratch', 'server', 'device', 'lend', 'allow', 'this computer'],
    available: () => !isLocal(),
  },
  {
    id: 'system.lendSsh',
    page: 'system',
    label: 'SSH hosts reached from here',
    description: 'Hosts the server may connect to from this computer, with its ssh, keys and known hosts. Choosing a host here adds it.',
    keywords: ['ssh', 'remote', 'server', 'device', 'lend', 'allow', 'hosts'],
    available: () => !isLocal(),
  },
  {
    id: 'system.lendConnectors',
    page: 'system',
    label: 'Connectors that run a program here',
    description: 'Your connectors the server may start on this computer. Adding or importing one here adds it; a changed program asks again.',
    keywords: ['connector', 'mcp', 'stdio', 'npx', 'program', 'server', 'lend', 'allow'],
    available: () => !isLocal(),
  },
  {
    id: 'system.lendHttp',
    page: 'system',
    label: 'Addresses reached from here',
    description: 'Model servers and connectors on this computer or its network that the server may reach through it.',
    keywords: ['ollama', 'lm studio', 'llama.cpp', 'comfyui', 'forge', 'image server', 'localhost', 'network', 'models', 'server', 'lend', 'allow'],
    available: () => !isLocal(),
  },
  {
    id: 'system.lendChatgptChat',
    page: 'system',
    label: 'ChatGPT Chat on this computer',
    description: 'Your ChatGPT Chat models answer through the ChatGPT window of this app.',
    keywords: ['chatgpt chat', 'browser', 'window', 'server', 'lend', 'allow'],
    available: () => !isLocal(),
  },
  {
    id: 'system.lendHome',
    page: 'system',
    label: 'Your instructions and skills from this computer',
    description: 'Sessions in folders on this computer use your ~/.claude/CLAUDE.md, ~/.atelier/ATELIER.md, skills, agents, commands and Claude Code settings here.',
    keywords: ['claude.md', 'atelier.md', 'skills', 'agents', 'commands', 'plugins', 'hooks', 'home', 'server', 'lend'],
    available: () => !isLocal(),
  },
  {
    id: 'system.diagnostics',
    page: 'system',
    label: 'Copy diagnostics',
    description:
      'Puts a plain-text summary on the clipboard to paste into a bug report: version, system, the last lines of the app log and the last error. Atelier sends nothing by itself, and the text leaves out keys, addresses, message text, file paths and names.',
    keywords: ['bug report', 'support', 'debug', 'log', 'logs', 'crash', 'error', 'report a problem', 'troubleshooting', 'copy'],
  },
  {
    id: 'system.dataFolder',
    page: 'system',
    label: 'Data folder',
    description: 'Where Atelier keeps its data on this computer.',
    keywords: ['storage', 'location', 'database', 'directory', 'path', 'finder', 'explorer', 'files'],
  },
  {
    id: 'personalModels.detect',
    page: 'personal-models',
    label: 'Found on this computer',
    description: 'Model servers answering on their default ports here (Ollama, llama.cpp, LM Studio).',
    keywords: ['auto-detect', 'scan', 'ollama', 'llama.cpp', 'lm studio', 'comfyui', 'forge', 'image server', 'local', 'my models'],
    available: () => !!desktop,
  },
  {
    id: 'personalModels.providers',
    page: 'personal-models',
    label: 'Models on your computers',
    description: 'Model servers and ChatGPT Chat on your own computers. Only you see their models, and only while that computer is connected.',
    keywords: ['personal', 'my models', 'local models', 'ollama', 'llama.cpp', 'lm studio', 'chatgpt chat', 'comfyui', 'forge', 'swarmui', 'invokeai', 'image server', 'image generation', 'computer', 'desktop', 'offline'],
  },
  {
    id: 'personalModels.add',
    page: 'personal-models',
    label: 'Add model server',
    description: 'Ollama, llama.cpp, LM Studio or another OpenAI-compatible server on this computer or its network.',
    keywords: ['personal', 'my models', 'local', 'connect', 'base url', 'address', 'ollama', 'llama.cpp', 'lm studio', 'openai-compatible'],
  },
  {
    id: 'personalModels.chatgptChat',
    page: 'personal-models',
    label: 'ChatGPT Chat on this computer',
    description: 'Your own ChatGPT, through the ChatGPT window of the desktop app here. Experimental.',
    keywords: ['chatgpt chat', 'browser', 'window', 'personal', 'my models', 'subscription'],
    available: () => !!desktop,
  },
  {
    id: 'providers.detect',
    page: 'providers',
    label: 'Detected on this machine',
    description: 'Local servers on their default ports and API keys in the environment.',
    keywords: ['auto-detect', 'scan', 'ollama', 'llama.cpp', 'lm studio', 'environment', 'api key'],
  },
  {
    id: 'providers.add',
    page: 'providers',
    label: 'Add provider',
    description: 'Connect Ollama, llama.cpp, LM Studio, Anthropic, OpenAI, Mistral, GitHub Copilot, OpenRouter, a ChatGPT or Mistral Vibe plan or any OpenAI-compatible endpoint.',
    keywords: [
      'connect',
      'api key',
      'base url',
      'endpoint',
      'ollama',
      'llama.cpp',
      'anthropic',
      'openai',
      'mistral',
      'vibe',
      'le chat',
      'openrouter',
      'vllm',
    ],
  },
  {
    id: 'imageProviders.detect',
    page: 'image-providers',
    label: 'Found on this computer',
    description: 'Image and sound servers answering on their default ports here.',
    keywords: ['auto-detect', 'scan', 'comfyui', 'forge', 'automatic1111', 'swarmui', 'invokeai', 'localai', 'koboldcpp', 'kokoro', 'speaches', 'local'],
  },
  {
    id: 'imageProviders.list',
    page: 'image-providers',
    label: 'Image, video and audio providers',
    description: 'Where images, videos and sounds are made, separate from the providers of text models.',
    keywords: ['image generation', 'video generation', 'audio generation', 'pictures', 'clips', 'speech', 'music', 'comfyui', 'workflows', 'health', 'gpu'],
  },
  {
    id: 'imageProviders.add',
    page: 'image-providers',
    label: 'Add image, video or audio provider',
    description: 'Connect a local server such as ComfyUI, Forge or Kokoro, a cloud service such as OpenAI, Google Gemini or ElevenLabs, or a service with many models such as OpenRouter or fal.ai. The video and audio ones are listed with their own names.',
    keywords: ['connect', 'api key', 'base url', 'endpoint', 'comfyui', 'forge', 'automatic1111', 'openai', 'gemini', 'stability', 'black forest labs', 'fal', 'replicate', 'openrouter', 'xai', 'elevenlabs', 'kokoro', 'text to speech', 'tts', 'music', 'test image'],
  },
  {
    id: 'imageModels.list',
    page: 'image-providers',
    label: 'Image, video and audio models',
    description: 'Hide models, mark favorites, say what each is good at and set its steps, guidance, sampler and scheduler, for video its usual length, frame rate and resolution, or for sound its usual voice and length. The text model reads the description when it chooses.',
    keywords: ['hide', 'favorite', 'visibility', 'description', 'tuning', 'steps', 'guidance', 'cfg', 'sampler', 'scheduler', 'video', 'length', 'seconds', 'fps', 'resolution', 'voice', 'speech', 'music'],
  },
  {
    id: 'models.defaults.image',
    page: 'image-providers',
    label: 'Default image model for everyone',
    description: 'What makes images unless a person or a conversation chooses another.',
    keywords: ['server default', 'system default', 'image generation'],
  },
  {
    id: 'models.defaults.video',
    page: 'image-providers',
    label: 'Default video model for everyone',
    description: 'What makes videos unless a person chooses another or names one when they ask.',
    keywords: ['server default', 'system default', 'video generation'],
    available: () => videoGenerationOffered(),
  },
  {
    id: 'models.defaults.speech',
    page: 'image-providers',
    label: 'Default speech model for everyone',
    description: 'What reads text aloud unless a person chooses another or names one when they ask.',
    keywords: ['server default', 'system default', 'text to speech', 'tts', 'voice'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'models.defaults.music',
    page: 'image-providers',
    label: 'Default music model for everyone',
    description: 'What makes music unless a person chooses another or names one when they ask.',
    keywords: ['server default', 'system default', 'music generation', 'songs'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'models.defaults.sound',
    page: 'image-providers',
    label: 'Default sound effects model for everyone',
    description: 'What makes sound effects unless a person chooses another or names one when they ask.',
    keywords: ['server default', 'system default', 'sound effects', 'sfx'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'imageGeneration.enabled',
    page: 'image-providers',
    label: 'Let models make images',
    description: 'Off: conversations don’t get the tool, whichever providers are set up.',
    keywords: ['turn off', 'disable', 'pictures', 'generate image'],
  },
  {
    id: 'imageGeneration.maxImagesPerTurn',
    page: 'image-providers',
    label: 'Images per turn',
    description: 'How many images one reply can make, so text on a web page can’t run up a bill.',
    keywords: ['limit', 'cap', 'budget', 'prompt injection'],
  },
  {
    id: 'imageGeneration.maxImagesPerUserPerDay',
    page: 'image-providers',
    label: 'Images per person per day',
    description: 'Counted across all of a person’s conversations, including deleted ones.',
    keywords: ['limit', 'cap', 'quota', 'budget', 'accounts'],
  },
  {
    id: 'imageGeneration.maxSpendPerUserPerDayUsd',
    page: 'image-providers',
    label: 'Spend per person per day',
    description: 'Counts images with a known or estimated cost. Local servers cost nothing here.',
    keywords: ['limit', 'cap', 'quota', 'budget', 'dollars', 'money', 'cost'],
  },
  {
    id: 'imageGeneration.videoEnabled',
    page: 'image-providers',
    label: 'Let models make videos',
    description: 'Off: conversations don’t get the video tool, whichever providers are set up. Images are not affected.',
    keywords: ['turn off', 'disable', 'clips', 'generate video'],
    available: () => videoGenerationOffered(),
  },
  {
    id: 'imageGeneration.maxVideosPerTurn',
    page: 'image-providers',
    label: 'Videos per turn',
    description: 'How many videos one reply can make. A video takes minutes and costs far more than an image, so the default is 2.',
    keywords: ['limit', 'cap', 'budget', 'prompt injection', 'clips'],
    available: () => videoGenerationOffered(),
  },
  {
    id: 'imageGeneration.maxVideosPerUserPerDay',
    page: 'image-providers',
    label: 'Videos per person per day',
    description: 'Counted across all of a person’s conversations, including deleted ones.',
    keywords: ['limit', 'cap', 'quota', 'budget', 'accounts', 'clips'],
    available: () => videoGenerationOffered(),
  },
  {
    id: 'imageGeneration.maxVideoSpendPerUserPerDayUsd',
    page: 'image-providers',
    label: 'Video spend per person per day',
    description: 'Counts videos with a known or estimated cost. Local servers cost nothing here.',
    keywords: ['limit', 'cap', 'quota', 'budget', 'dollars', 'money', 'cost', 'clips'],
    available: () => videoGenerationOffered(),
  },
  {
    id: 'imageGeneration.audioEnabled',
    page: 'image-providers',
    label: 'Let models make sounds',
    description: 'Off: conversations don’t get the sound tool, whichever providers are set up. Images and videos are not affected.',
    keywords: ['turn off', 'disable', 'speech', 'tts', 'music', 'sound effects', 'generate audio'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'imageGeneration.maxAudioPerTurn',
    page: 'image-providers',
    label: 'Sounds per turn',
    description: 'How many sounds one reply can make: speech, music and effects together. The default is 6, enough for a short dialogue made line by line.',
    keywords: ['limit', 'cap', 'budget', 'prompt injection', 'speech', 'music'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'imageGeneration.maxAudioPerUserPerDay',
    page: 'image-providers',
    label: 'Sounds per person per day',
    description: 'Counted across all of a person’s conversations, including deleted ones.',
    keywords: ['limit', 'cap', 'quota', 'budget', 'accounts', 'speech', 'music'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'imageGeneration.maxAudioSpendPerUserPerDayUsd',
    page: 'image-providers',
    label: 'Sound spend per person per day',
    description: 'Counts sounds with a known or estimated cost. Local servers cost nothing here.',
    keywords: ['limit', 'cap', 'quota', 'budget', 'dollars', 'money', 'cost', 'speech', 'music'],
    available: () => audioGenerationOffered(),
  },
  {
    id: 'models.defaults.chat',
    page: 'models',
    label: 'Default model for everyone',
    description: 'New chats and Code sessions start with this model unless people choose their own.',
    keywords: ['default chat model', 'chat', 'server default', 'system default'],
  },
  {
    id: 'models.defaults.small',
    page: 'models',
    label: 'Small model',
    description: 'Writes titles, summaries and memory. “Same as the chat” uses each chat’s own model.',
    keywords: ['titles', 'summaries', 'memory', 'compaction', 'background', 'fast model'],
  },
  {
    id: 'models.list',
    page: 'models',
    label: 'Available models',
    description: 'Rename, hide or favorite models, and override what was detected about them.',
    keywords: [
      'hide',
      'favorite',
      'visibility',
      'context length',
      'tool calling',
      'probe tools',
      'vision',
      'temperature',
      'overrides',
    ],
  },
  { id: 'models.aliases.opus', page: 'models', label: 'opus', keywords: ALIAS_KEYWORDS },
  { id: 'models.aliases.sonnet', page: 'models', label: 'sonnet', keywords: ALIAS_KEYWORDS },
  { id: 'models.aliases.haiku', page: 'models', label: 'haiku', keywords: ALIAS_KEYWORDS },
  { id: 'models.aliases.fable', page: 'models', label: 'fable', keywords: ALIAS_KEYWORDS },
  {
    id: 'capabilities.webSearch.enabled',
    page: 'capabilities',
    label: 'Web search',
    description: 'Let chats look things up on the web. Nothing to set up: Atelier searches by itself.',
    keywords: ['internet', 'search engine', 'duckduckgo', 'bing', 'brave', 'browse', 'online'],
  },
  {
    id: 'capabilities.webSearch.provider',
    page: 'capabilities',
    label: 'Search engine',
    description:
      'Built-in search needs no account or key. Use your own SearXNG, Brave Search or Tavily to keep searches on a service you choose.',
    keywords: ['searxng', 'brave', 'tavily', 'provider', 'built-in', 'api key'],
  },
  {
    id: 'capabilities.webSearch.status',
    page: 'capabilities',
    label: 'Test search',
    description:
      'Searches are sent to the engine that answers, as a browser would send them; news searches also go to Bing News and Google News, and programming searches to Stack Overflow, Hacker News and GitHub. The server or this computer then opens the first result pages, and your own SearXNG keeps searches off third parties.',
    keywords: ['status', 'limited', 'blocked', 'working', 'privacy'],
  },
  {
    id: 'capabilities.webSearch.url',
    page: 'capabilities',
    label: 'SearXNG URL',
    description: 'Base URL of your instance. JSON output must be enabled in its settings.yml.',
    keywords: ['searxng', 'instance', 'self-hosted'],
  },
  {
    id: 'capabilities.webSearch.apiKey',
    page: 'capabilities',
    label: 'Search API key',
    description: 'Stored encrypted in the secret store, never in settings files.',
    keywords: ['brave', 'tavily', 'token', 'key'],
  },
  {
    id: 'capabilities.webFetch',
    page: 'capabilities',
    label: 'Web fetch',
    description: 'Let chats read web pages and documents by URL.',
    keywords: ['url', 'browse', 'read page', 'internet'],
  },
  {
    id: 'prompts.organizationInstructions',
    page: 'capabilities',
    label: 'Instructions for every conversation',
    description:
      'What models are told in every chat and Code session, for every account, ahead of anything a person or project asks. Applies to new conversations. Code and chats working in a folder also follow the system AGENTS.md (Admin › Code).',
    keywords: ['organization', 'company', 'system prompt', 'custom instructions', 'admin instructions', 'policy'],
  },
  {
    id: 'memory.manualEditing',
    page: 'capabilities',
    label: 'Let people edit memory by hand',
    description:
      'Adds Edit to every memory entry in Settings › Memory, for changing its title, summary and details directly. Without it, memory changes only through Atelier.',
    keywords: ['memory', 'edit', 'manual', 'entries', 'preferences', 'profile'],
  },
  {
    id: 'safeguards.enabled',
    page: 'capabilities',
    label: 'Extra safeguards for everyone',
    description:
      "Off by default: models then follow only their own and their provider's rules. When on, the categories below apply to every conversation, except for people Users sets otherwise.",
    keywords: [
      'content filter',
      'censorship',
      'moderation',
      'nsfw',
      'adult',
      'sexual',
      'hate',
      'political',
      'harassment',
      'self-harm',
      'safety',
    ],
  },
  {
    id: 'safeguards.categories.sexual',
    page: 'capabilities',
    label: 'Explicit sexual content',
    description: 'Erotica and graphic sexual material. Sex education and health questions are still answered.',
    keywords: ['nsfw', 'adult', 'erotica', 'safeguards'],
  },
  {
    id: 'safeguards.categories.hate',
    page: 'capabilities',
    label: 'Hate and violent extremism',
    description:
      'Content that demeans people for who they are, and extremist propaganda. Every political view can still be discussed and argued.',
    keywords: ['hate speech', 'political', 'extremism', 'safeguards'],
  },
  {
    id: 'safeguards.categories.harassment',
    page: 'capabilities',
    label: 'Harassment of private people',
    description: 'Threats and insults aimed at real private people, and help finding where they live or work.',
    keywords: ['bullying', 'doxxing', 'safeguards'],
  },
  {
    id: 'safeguards.categories.selfHarm',
    page: 'capabilities',
    label: 'Self-harm',
    description: 'No methods or doses for someone who seems at risk; the model answers with care and points to help.',
    keywords: ['suicide', 'crisis', 'wellbeing', 'safeguards'],
  },
  {
    id: 'safeguards.profile',
    page: 'capabilities',
    label: 'Younger people',
    description:
      'For accounts that may belong to someone under 18: no romantic role-play, and no instructions for alcohol, drugs or risky stunts.',
    keywords: ['children', 'teen', 'minor', 'school', 'safeguards'],
  },
  {
    id: 'safeguards.crisisResources',
    page: 'capabilities',
    label: 'Crisis resource',
    description: 'A helpline or service the self-harm safeguard can point to, such as a national number.',
    keywords: ['helpline', 'hotline', 'safeguards'],
  },
  {
    id: 'permissions.defaultMode',
    page: 'admin-code',
    label: 'Default permission mode',
    description: 'The mode new Code sessions and chats start in (a chat that would start in Plan asks instead). People can switch it in each conversation.',
    keywords: ['auto mode', 'classifier', 'ask', 'accept edits', 'plan mode', 'bypass', 'permissions'],
  },
  {
    id: 'permissions.allow',
    page: 'admin-code',
    label: 'Allow rules',
    description: 'Tool calls that match run without asking.',
    keywords: ['permissions', 'allowlist', 'always allow', 'bash', 'claude code'],
  },
  {
    id: 'permissions.ask',
    page: 'admin-code',
    label: 'Ask rules',
    description: 'Tool calls that match always ask first, in every mode.',
    keywords: ['permissions', 'prompt', 'confirm', 'claude code'],
  },
  {
    id: 'permissions.deny',
    page: 'admin-code',
    label: 'Deny rules',
    description: 'Tool calls that match are blocked, in every mode.',
    keywords: ['permissions', 'block', 'forbid', 'denylist', 'claude code'],
  },
  {
    id: 'permissions.additionalDirectories',
    page: 'admin-code',
    label: 'Additional directories',
    description: 'Folders sessions may use besides their workspace. Reaching anywhere else asks first.',
    keywords: ['permissions', 'folders', 'paths', 'workspace', 'roots'],
  },
  {
    id: 'ultracode.enabled',
    page: 'admin-code',
    label: 'Ultracode',
    description: `The last effort level in Code, on every model except ChatGPT Chat, which brings its own stops: the model plans, has up to ${ULTRACODE_MAX_SUBAGENTS} sub-agents per request investigate and check its work, and uses far more tokens. Off: sessions that chose it run at Extra.`,
    keywords: ['effort', 'sub-agents', 'agents', 'orchestration', 'tokens', 'cost', 'budget', 'extra'],
  },
  {
    id: 'compat.claudeCode',
    page: 'admin-code',
    label: 'Claude Code compatibility',
    description:
      'Also read what projects and your home folder keep for Claude Code: CLAUDE.md and rules, .claude/settings.json permission rules and hooks, and the skills, commands, agents and plugins in .claude folders.',
    keywords: ['claude.md', '.claude', 'settings.json', 'import', 'rules', 'skills', 'commands', 'agents', 'hooks', 'plugins'],
  },
  {
    id: 'hooks',
    page: 'admin-code',
    label: 'Hooks',
    description:
      'Commands that run at points of every Code session and chat task on this computer, in Claude Code’s settings format. Projects bring their own in .atelier or .claude settings; people’s own devices run only those.',
    keywords: [
      'pretooluse',
      'posttooluse',
      'stop',
      'sessionstart',
      'userpromptsubmit',
      'claude code',
      'automation',
      'lint',
      'format',
    ],
  },
  {
    id: 'checkpoints.retentionDays',
    page: 'admin-code',
    label: 'Keep checkpoints for',
    description: 'How long file versions are kept for rewinding Code sessions.',
    keywords: ['rewind', 'undo', 'restore', 'history', 'days', 'storage'],
  },
  {
    id: 'instructions.system',
    page: 'admin-code',
    label: 'System AGENTS.md',
    description:
      'Instructions every Code session and chat working in a folder follows, for every account. Projects add their own CLAUDE.md and AGENTS.md.',
    keywords: ['agents.md', 'claude.md', 'system prompt', 'instructions', 'memory', 'global'],
  },
  {
    id: 'connectors.list',
    page: 'connectors',
    label: 'Connectors',
    description:
      'MCP servers that give sessions tools from other services. People turn them on in each session, and their tools ask before they run unless you allow them here.',
    keywords: [
      'mcp',
      'model context protocol',
      'servers',
      'integrations',
      'add connector',
      'import',
      'claude code',
      'tool permissions',
      'always allow',
      'block',
      'cloudflare',
      'github',
      'notion',
      'linear',
      'brave search',
      'home assistant',
      'stdio',
      'http',
      'sse',
      'headers',
    ],
  },
  {
    id: 'plugins.installed',
    page: 'plugins',
    label: 'Installed plugins',
    description:
      'Bundles of skills, commands and agents. Turning one off takes what it brings out of every session. Plugins installed with Claude Code can only be turned on or off here.',
    keywords: ['enable', 'disable', 'uninstall', 'claude code', 'skills', 'commands', 'agents', 'extensions'],
  },
  {
    id: 'plugins.marketplace',
    page: 'plugins',
    label: 'Add from a marketplace',
    description:
      'A GitHub repository with a .claude-plugin/marketplace.json, as Claude Code uses: owner/repo or a github.com URL.',
    keywords: ['install plugin', 'marketplace', 'browse', 'github', 'claude code', 'extensions'],
  },
  {
    id: 'secrets.list',
    page: 'secrets',
    label: 'Keys and secrets',
    description:
      'API keys and tokens, kept encrypted. Settings refer to them as ${secret:id}; their values never leave the backend.',
    keywords: ['api key', 'token', 'credentials', 'rotate', 'delete', 'secret store', 'encrypted', 'used by'],
  },
  {
    id: 'limits.tokensPerDay',
    page: 'limits',
    label: 'Tokens per person per day',
    description:
      'Input, output and cache tokens of text models, counted across all of a person’s conversations, including deleted ones. A day is a UTC day and resets at 00:00 UTC. Empty means no limit.',
    keywords: ['limit', 'cap', 'quota', 'budget', 'daily', 'accounts', 'shared server'],
  },
  {
    id: 'limits.tokensPer30Days',
    page: 'limits',
    label: 'Tokens per person per 30 days',
    description: 'The same count over today and the 29 days before it. Empty means no limit.',
    keywords: ['limit', 'cap', 'quota', 'budget', 'monthly', 'rolling'],
  },
  {
    id: 'limits.costUsdPerDay',
    page: 'limits',
    label: 'Cost per person per day',
    description:
      'In dollars. Counts only requests to models that have a price (Settings › Usage › Prices); local models cost nothing here, so limit them by tokens. Empty means no limit.',
    keywords: ['limit', 'cap', 'quota', 'budget', 'dollars', 'money', 'spend', 'daily'],
  },
  {
    id: 'limits.costUsdPer30Days',
    page: 'limits',
    label: 'Cost per person per 30 days',
    description: 'In dollars over today and the 29 days before it, for requests to models that have a price. Empty means no limit.',
    keywords: ['limit', 'cap', 'quota', 'budget', 'dollars', 'money', 'spend', 'monthly', 'rolling'],
  },
  {
    id: 'limits.requestsPerHour',
    page: 'limits',
    label: 'Requests per person per hour',
    description: 'Model requests in the last 60 minutes, including titles, memory updates and sub-agents. Requests under way count too. Empty means no limit.',
    keywords: ['limit', 'cap', 'quota', 'rate limit', 'hourly', 'throttle'],
  },
  {
    id: 'limits.people',
    page: 'limits',
    label: 'People',
    description:
      'Each person’s usage against their limits. Raise or lower a limit for one person, lift one, or exempt them from all. Admins are not exempt unless you say so.',
    keywords: ['limit', 'exempt', 'override', 'near limit', 'quota', 'accounts', 'users'],
  },
  {
    id: 'users.list',
    page: 'users',
    label: 'Users',
    description: 'Everyone who can sign in, with their role and status.',
    keywords: ['people', 'accounts', 'members', 'add user', 'role', 'admin', 'reset password', 'disable', 'delete'],
  },
  {
    id: 'users.pending',
    page: 'users',
    label: 'Waiting for approval',
    description: 'People who signed up themselves. Approve them to let them in.',
    keywords: ['approve', 'reject', 'sign up', 'pending', 'requests'],
  },
  {
    id: 'users.invites',
    page: 'users',
    label: 'Invite codes',
    description: 'Each code creates one account and expires after 7 days. Only the last group of a code is shown here.',
    keywords: ['invite', 'join', 'code', 'link', 'share'],
  },
  {
    id: 'server.version',
    page: 'server',
    label: 'Server version',
    description: 'The version of Atelier this server runs.',
    keywords: ['version', 'update', 'upgrade', 'release', 'latest', 'docker', 'image'],
  },
  {
    id: 'server.update',
    page: 'server',
    label: 'Update server',
    description:
      'Installs the newest version of Atelier on this server. It restarts, and everyone reconnects by themselves.',
    keywords: ['update', 'upgrade', 'docker compose pull', 'restart', 'updater', 'new version'],
  },
  {
    id: 'server.signup',
    page: 'server',
    label: 'Sign-up',
    description:
      'Invite only: admins add people or give them invite codes. Open: anyone who can reach this server can create an account, which waits for an admin to approve it.',
    keywords: ['registration', 'open sign-up', 'invite only', 'join', 'policy'],
  },
  {
    id: 'server.oidc',
    page: 'server',
    label: 'Single sign-on',
    description: 'Lets people sign in to this server in a browser through an OpenID Connect identity provider, such as Authentik, Keycloak or Google. The desktop app keeps signing in with passwords.',
    keywords: ['sso', 'oidc', 'openid connect', 'oauth', 'authentik', 'keycloak', 'authelia', 'identity provider', 'idp', 'login'],
  },
  {
    id: 'activity.log',
    page: 'activity',
    label: 'Activity log',
    description:
      'Who changed what on this server, newest first: sign-ins and failed sign-ins, accounts, invites, settings, providers, secrets, connectors, plugins, models, limits and server updates. Passwords, keys and other secret values are never recorded.',
    keywords: ['audit', 'audit log', 'history', 'who did', 'changes', 'sign-ins', 'failed login', 'security', 'events', 'admin actions', 'compliance'],
    available: () => auditLogOffered(),
  },
  {
    id: 'activity.retention',
    page: 'activity',
    label: 'Keep activity for',
    description: 'Events older than this are deleted once a day. Between 7 and 365 days.',
    keywords: ['audit', 'retention', 'days', 'delete old', 'prune', 'how long'],
    available: () => auditLogOffered(),
  },
  {
    id: 'activity.export',
    page: 'activity',
    label: 'Export activity',
    description: 'Saves the events that match the filters above as a JSON file, or everything recorded when none are set.',
    keywords: ['audit', 'download', 'json', 'save', 'backup', 'report'],
    available: () => auditLogOffered(),
  },
  {
    id: 'developer.inspector',
    page: 'developer',
    label: 'Record provider requests',
    description:
      'Lists the requests sent to model providers: address, status, timing and headers with credentials masked. Prompts and replies are never recorded.',
    keywords: ['inspector', 'debug', 'network', 'http', 'api', 'requests', 'headers'],
  },
  {
    id: 'developer.connectorLogs',
    page: 'developer',
    label: 'Connector logs',
    keywords: ['mcp', 'connectors', 'stderr', 'debug', 'errors'],
  },
  {
    id: 'developer.reload',
    page: 'developer',
    label: 'Reload connectors and extensions',
    description: 'Reconnects every connector and reads skills, commands, agents and plugins again.',
    keywords: ['restart', 'refresh', 'mcp', 'skills', 'plugins'],
  },
  {
    id: 'memory.searchChats',
    page: 'memory',
    label: 'Search and reference chats',
    description: 'Let Atelier search for relevant details in your past chats.',
    keywords: ['history', 'past conversations', 'recall', 'remember', 'search'],
  },
  {
    id: 'memory.generate',
    page: 'memory',
    label: 'Generate memory from chats',
    description: 'Let Atelier remember details from your chats.',
    keywords: ['remember', 'learn', 'personalization', 'context', 'about me'],
  },
  {
    id: 'memory.sensitive',
    page: 'memory',
    label: 'Include sensitive topics in memory',
    description: 'Let Atelier remember details about sensitive topics like health or religious beliefs.',
    keywords: ['health', 'religion', 'private', 'personal'],
  },
  {
    id: 'memory.import',
    page: 'memory',
    label: 'Import memory from other AI providers',
    description: 'Bring what another assistant remembers about you into Atelier.',
    keywords: ['import', 'export', 'migrate', 'move', 'switch'],
  },
  {
    id: 'memory.entries',
    page: 'memory',
    label: 'Your memory',
    description:
      'What Atelier remembers about you, your topics, areas, people and projects. Open an entry to change or delete it.',
    keywords: ['preferences', 'profile', 'topics', 'areas', 'people', 'projects', 'forget', 'delete'],
  },
] as const satisfies readonly SettingEntry[];

export type SettingId = (typeof SETTINGS_INDEX)[number]['id'];

const byId = new Map<string, SettingEntry>(SETTINGS_INDEX.map((e) => [e.id, e]));

export function settingEntry(id: SettingId): SettingEntry {
  return byId.get(id)!;
}

const pageLabels = new Map(SETTINGS_PAGES.map((p) => [p.id, p.label]));

/**
 * Entries this person may open (admin pages and rows only for admins, rows only where they work) that match every word of `query`
 * in their label, description, keywords or page name. Label matches rank first (prefix before substring), then index order.
 */
export function searchSettings(query: string, admin: boolean): SettingEntry[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const rank = (e: SettingEntry) => {
    const label = e.label.toLowerCase();
    return label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
  };
  const pages = new Set(visiblePages(admin).map((p) => p.id));
  return SETTINGS_INDEX.filter((e: SettingEntry) => {
    const haystack = [e.label, e.description ?? '', ...(e.keywords ?? []), pageLabels.get(e.page)]
      .join('\n')
      .toLowerCase();
    return (
      pages.has(e.page) && (admin || !e.admin) && (e.available?.() ?? true) && words.every((w) => haystack.includes(w))
    );
  })
    .map((e, i) => ({ e, i, r: rank(e) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ e }) => e);
}
