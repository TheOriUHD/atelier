import { defineConfig, passthroughImageService } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.atelierhq.dev',
  trailingSlash: 'always',
  // Screenshots are already sized WebP; no native image pipeline (sharp) needed.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'Atelier Docs',
      description: 'Install Atelier, connect your models, run a server, and get the most out of Chat, Cowork and Code.',
      logo: { src: './src/assets/icon.svg', alt: 'Atelier' },
      favicon: '/icon.svg',
      customCss: ['./src/styles/theme.css'],
      components: { Footer: './src/components/Footer.astro' },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/TheOriUHD/atelier' }],
      // Generated pages (prompts, tools, settings) set `editUrl: false`; the contribution terms are in CONTRIBUTING.md.
      editLink: { baseUrl: 'https://github.com/TheOriUHD/atelier/edit/main/apps/docs/' },
      lastUpdated: true,
      credits: false,
      sidebar: [
        {
          label: 'Start here',
          items: ['getting-started', 'install', 'providers', 'models', 'local-models', 'chatgpt'],
        },
        {
          label: 'Using Atelier',
          items: ['chat', 'artifacts', 'projects', 'cowork', 'code', 'permissions', 'computer-use', 'effort', 'sessions', 'loops', 'shortcuts', 'web-search', 'memory'],
        },
        {
          label: 'Extend',
          items: ['customize', 'connectors', 'hooks-and-plugins', 'claude-code-compatibility'],
        },
        {
          label: 'Running it',
          items: ['self-hosting', 'accounts', 'remote-control', 'security', 'privacy', 'data-and-files', 'environment-variables', 'updates', 'troubleshooting'],
        },
        {
          label: 'System prompts',
          items: ['prompts', 'prompts/chat', 'prompts/cowork', 'prompts/code', 'prompts/shared', 'prompts/side-prompts', 'prompts/context-updates', 'prompts/assembled', 'prompts/design'],
        },
        {
          label: 'Under the hood',
          items: ['how-it-works', 'reference/tools', 'reference/settings'],
        },
        { label: 'About', items: ['faq', 'license'] },
      ],
    }),
  ],
});
