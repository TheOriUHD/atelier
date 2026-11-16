import { defineConfig, passthroughImageService } from 'astro/config';
import starlight from '@astrojs/starlight';
import { SIDEBAR } from './src/sidebar.mjs';

export default defineConfig({
  site: 'https://docs.atelierhq.dev',
  trailingSlash: 'always',
  // Screenshots are already sized WebP; no native image pipeline (sharp) needed.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'Atelier Docs',
      description: 'Install Atelier, connect your models, run a server, and get the most out of Chat and Code.',
      logo: { src: './src/assets/icon.svg', alt: 'Atelier' },
      favicon: '/icon.svg',
      customCss: ['./src/styles/theme.css'],
      components: { Footer: './src/components/Footer.astro' },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/TheOriUHD/atelier' }],
      // Generated pages (prompts, tools, settings) set `editUrl: false`; the contribution terms are in CONTRIBUTING.md.
      editLink: { baseUrl: 'https://github.com/TheOriUHD/atelier/edit/main/apps/docs/' },
      lastUpdated: true,
      credits: false,
      // Search and social previews: the site's picture, and what the site is, for engines that read structured data.
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://atelierhq.dev/og.jpg' } },
        { tag: 'meta', attrs: { property: 'og:site_name', content: 'Atelier Docs' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://atelierhq.dev/og.jpg' } },
        // Bing Webmaster Tools' proof that this site is ours (the same tag is on the website).
        { tag: 'meta', attrs: { name: 'msvalidate.01', content: '41F426E82A86E297684709193B1CF189' } },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            '@id': 'https://docs.atelierhq.dev/#website',
            url: 'https://docs.atelierhq.dev/',
            name: 'Atelier Docs',
            description: 'The documentation of Atelier, a self-hosted AI workspace with Chat and Code on the models you choose.',
            inLanguage: 'en',
            publisher: { '@id': 'https://atelierhq.dev/#org' },
          }),
        },
      ],
      // Per page: a Markdown copy for agents (scripts/seo.mjs writes it) and the article's structured data.
      routeMiddleware: './src/route-data.ts',
      sidebar: SIDEBAR,
    }),
  ],
});
