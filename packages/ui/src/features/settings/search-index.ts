/**
 * Every addressable row in Settings. Rows render their label and description from here, so the
 * search results and the page can't drift apart. `id` is the `?row=` value and the row's
 * `data-setting-row` attribute.
 */
import { ULTRACODE_MAX_SUBAGENTS } from '@atelier/protocol';
import { passkeysAvailable } from '../auth/passkeys.ts';
import { desktop } from '../../lib/platform.ts';
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
    id: 'notifications.taskFinished',
    page: 'general',
    label: 'Notify me when a task finishes',
    description: 'A system notification when a Cowork task ends while you’re in another window or app.',
    keywords: ['notifications', 'alert', 'done', 'work', 'background'],
  },
  {
    id: 'notifications.permissionNeeded',
    page: 'general',
    label: 'Notify me when a task needs me',
    description: 'A system notification when a Cowork task waits for your answer or permission.',
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
      'Your own conventions and preferences for Code sessions and Cowork tasks, in Markdown. Every new one and its sub-agents read them; where a project’s ATELIER.md disagrees, yours win.',
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
    id: 'account.server',
    page: 'account',
    label: 'Server',
    description: 'The Atelier server this app uses. Switch to another one, or to running on this computer.',
    keywords: ['switch server', 'change server', 'this computer', 'connection', 'setup'],
    available: () => !isLocal() && !!desktop?.connection?.reset,
  },
  {
    id: 'account.changeSetup',
    page: 'account',
    label: 'Setup',
    description: 'Atelier runs on this computer. Switch to an Atelier server, or choose again.',
    keywords: ['change setup', 'server', 'switch', 'connection', 'sign out', 'log out'],
    available: () => isLocal() && !!desktop?.connection?.reset,
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
      'Every chat, Cowork task and Code session, with its messages, files and artifacts. Projects stay. This can’t be undone.',
    keywords: ['erase', 'wipe', 'clear history', 'remove chats', 'sessions'],
  },
  {
    id: 'usage.overview',
    page: 'usage',
    label: 'Your usage',
    description: 'Requests, tokens and cost of your chats, Cowork tasks and Code sessions.',
    keywords: ['tokens', 'requests', 'cost', 'spend', 'statistics', 'dollars', 'everyone'],
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
    id: 'usage.prices',
    page: 'usage',
    label: 'Prices',
    description:
      'Dollars per million tokens, per model, in place of the provider’s list price (Anthropic and OpenAI models without one here use it). A price counts for requests made after it is set.',
    keywords: ['pricing', 'price table', 'cost', 'dollars', 'cache'],
    admin: true,
  },
  {
    id: 'prefs.permissions.allow',
    page: 'code',
    label: 'Always-allowed actions',
    description:
      'What you approved with “Always allow” in a permission prompt. These rules apply in your Code and Cowork sessions and to connector tools in chats, on top of the rules your admin set.',
    keywords: ['permissions', 'rules', 'always allow', 'approve', 'bash', 'claude code', 'connector', 'chat'],
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
  { id: 'system.version', page: 'system', label: 'Version', keywords: ['about', 'release', 'build', 'desktop app'] },
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
    keywords: ['ollama', 'lm studio', 'llama.cpp', 'localhost', 'network', 'models', 'server', 'lend', 'allow'],
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
    id: 'system.dataFolder',
    page: 'system',
    label: 'Data folder',
    description: 'Where Atelier keeps its data on this computer.',
    keywords: ['storage', 'location', 'database', 'directory', 'path', 'finder', 'explorer', 'files'],
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
    description: 'Connect Ollama, llama.cpp, LM Studio, Anthropic, OpenAI, GitHub Copilot, OpenRouter, a ChatGPT plan or any OpenAI-compatible endpoint.',
    keywords: [
      'connect',
      'api key',
      'base url',
      'endpoint',
      'ollama',
      'llama.cpp',
      'anthropic',
      'openai',
      'openrouter',
      'vllm',
    ],
  },
  {
    id: 'models.defaults.chat',
    page: 'models',
    label: 'Default model for everyone',
    description: 'New chats, Cowork and Code sessions start with this model unless people choose their own.',
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
      'What models are told in every Chat, Cowork and Code conversation, for every account, ahead of anything a person or project asks. Applies to new conversations. Code and Cowork also follow the system AGENTS.md (Admin › Code).',
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
    description: 'The mode new Code sessions and Cowork tasks start in. People can switch it in each Code session.',
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
      'Commands that run at points of every Code session and Cowork task on this computer, in Claude Code’s settings format. Projects bring their own in .atelier or .claude settings; people’s own devices run only those.',
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
      'Instructions every Code session and Cowork task follows, for every account. Projects add their own CLAUDE.md and AGENTS.md.',
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
