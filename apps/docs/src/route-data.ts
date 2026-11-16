// What every docs page tells search engines and AI agents about itself: where its Markdown copy is (written after the
// build by scripts/seo.mjs) and its structured data.
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

const DOCS = 'https://docs.atelierhq.dev';

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const slug = route.entry.id.replace(/\/index$/, '');
  // The home page is a splash page of links (llms.txt is its Markdown); the 404 page isn't a page.
  if (!slug || slug === 'index' || slug === '404') return;
  const url = `${DOCS}/${slug}/`;
  route.head.push({ tag: 'link', attrs: { rel: 'alternate', type: 'text/markdown', href: `/${slug}.md` } });
  route.head.push({
    tag: 'script',
    attrs: { type: 'application/ld+json' },
    content: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: route.entry.data.title,
      ...(route.entry.data.description ? { description: route.entry.data.description } : {}),
      url,
      mainEntityOfPage: url,
      inLanguage: 'en',
      ...(route.lastUpdated ? { dateModified: route.lastUpdated.toISOString() } : {}),
      isPartOf: { '@id': `${DOCS}/#website` },
      publisher: { '@id': 'https://atelierhq.dev/#org' },
      about: { '@id': 'https://atelierhq.dev/#app' },
    }),
  });
});
