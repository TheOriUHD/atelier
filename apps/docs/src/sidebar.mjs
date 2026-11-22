// The docs' sidebar, in one place for the config and for scripts/seo.mjs (the order of llms.txt).
export const SIDEBAR = [
  {
    label: 'Start here',
    items: ['getting-started', 'install', 'cli', 'providers', 'models', 'what-works-where', 'local-models', 'chatgpt'],
  },
  {
    label: 'Using Atelier',
    items: ['chat', 'dictation', 'artifacts', 'image-generation', 'video-generation', 'audio-generation', 'decision-models', 'projects', 'code', 'permissions', 'co-op', 'computer-use', 'effort', 'sessions', 'loops', 'shortcuts', 'web-search', 'memory'],
  },
  {
    label: 'Extend',
    items: ['customize', 'connectors', 'hooks-and-plugins', 'claude-code-compatibility'],
  },
  {
    label: 'Running it',
    items: ['self-hosting', 'accounts', 'remote-control', 'security', 'privacy', 'data-and-files', 'environment-variables', 'updates', 'troubleshooting', 'reporting-issues'],
  },
  {
    label: 'System prompts',
    items: ['prompts', 'prompts/chat', 'prompts/code', 'prompts/shared', 'prompts/side-prompts', 'prompts/context-updates', 'prompts/assembled', 'prompts/design'],
  },
  {
    label: 'Under the hood',
    items: ['how-it-works', 'reference/tools', 'reference/settings', 'reference/cli'],
  },
  { label: 'About', items: ['faq', 'license'] },
];
