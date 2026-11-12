import { readFileSync } from 'node:fs';
import path from 'node:path';
import training from './training.json' with { type: 'json' };

const city = 'Набережные Челны';
const name = 'Antipov Team';
const street = 'проспект Сююмбике, 2/19';
const location = `${city}, ${street}, ТЦ «Омега», 2 этаж`;
const phone = '+7 960 080 25 52';
const phoneLink = 'tel:+79600802552';
const maps = 'https://yandex.ru/maps/org/158240839725/';
const twoGis = 'https://2gis.ru/nabchelny/firm/70000001096882624';
const logo = '/assets/antipov-team-lockup.svg';
const teamPhoto = '/assets/gallery/team-in-the-gym.jpg';
const homeTitle = `Клуб единоборств ${name} — ${city}`;
const homeDescription = 'ММА, вольная борьба, бокс, джиу-джитсу, грепплинг, кикбоксинг и боевое самбо в Набережных Челнах. Детские группы с 3,5 лет и тренировки для взрослых в ТЦ «Омега».';
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => entities[char]);
const serialize = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
const sectionUrl = (slug) => `/sekcii/${slug}/`;

function metadata(title, description, canonical, image) {
  const values = [title, description, canonical, image].map(escapeHtml);
  return `<title>${values[0]}</title>
    <meta name="description" content="${values[1]}">
    <link rel="canonical" href="${values[2]}">
    <meta property="og:type" content="website">
    <meta property="og:locale" content="ru_RU">
    <meta property="og:title" content="${values[0]}">
    <meta property="og:description" content="${values[1]}">
    <meta property="og:url" content="${values[2]}">
    <meta property="og:image" content="${values[3]}">`;
}

function links(excludedSlug) {
  return training.directions.filter(({ slug }) => slug !== excludedSlug).map(({ slug, title }) =>
    `<li><a href="${sectionUrl(slug)}">${escapeHtml(title)}</a></li>`).join('\n');
}

function clubHeader() {
  return `<header class="club-page-header"><a href="/" aria-label="${name} — главная">
    <img src="${logo}" alt="${name}" width="184" height="60"></a>
    <a href="${phoneLink}">${phone}</a></header>`;
}

function clubContact() {
  return `<section id="contacts" class="club-page-panel">
    <h2>Как нас найти</h2>
    <address>${location}<br>Отдельный вход со стороны отеля Open City</address>
    <p class="club-page-actions"><a class="club-page-button" href="${phoneLink}">Позвонить ${phone}</a>
    <a href="${maps}">Яндекс Карты</a><a href="${twoGis}">2ГИС</a></p>
  </section>`;
}

function renderLanding(source, origin) {
  const templateTag = /(<script type="__bundler\/template">)([\s\S]*?)(<\/script>)/;
  const match = source.match(templateTag);
  if (!match) throw new Error('Landing template missing');
  const seo = metadata(homeTitle, homeDescription, `${origin}/`, `${origin}${teamPhoto}`);
  const business = serialize({
    '@context': 'https://schema.org',
    '@type': 'SportsActivityLocation',
    '@id': `${origin}/#club`,
    name,
    description: homeDescription,
    url: `${origin}/`,
    image: `${origin}${teamPhoto}`,
    telephone: '+79600802552',
    address: {
      '@type': 'PostalAddress', streetAddress: street, addressLocality: city,
      addressRegion: 'Республика Татарстан', postalCode: '423812', addressCountry: 'RU',
    },
    hasMap: maps,
    sameAs: [twoGis, maps],
  });
  const head = `${seo}\n<script type="application/ld+json">${business}</script>`;
  const template = JSON.parse(match[2])
    .replace('<!-- site-meta -->', () => head)
    .replace('/* club-training */ null', () => serialize(training));
  const encoded = JSON.stringify(template).replace(/<\//g, '<\\u002F');
  const content = `${clubHeader()}<main class="club-page-main">
    <h1>${homeTitle}</h1><p class="club-page-intro">${homeDescription}</p>
    <section class="club-page-panel"><h2>Спортивные секции</h2>
    <ul class="club-page-links">${links()}</ul></section>
    ${clubContact()}
  </main>`;
  return source.replace(templateTag, () => match[1] + encoded + match[3])
    .replace('<!-- site-meta -->', () => head)
    .replace('<!-- site-content -->', () => content);
}

function renderSection(direction, origin) {
  const { slug, title, age, intro, remainder, scheduleLink } = direction;
  const heading = `${title} в Набережных Челнах`;
  const description = `${heading} ${age}. Расписание тренировок и запись в клуб ${name}, ТЦ «Омега».`;
  const group = training.scheduleGroups.find(({ id }) => `#${id}` === scheduleLink);
  const rows = group.slots.map(({ days, time, group: audience }) =>
    `<tr><td>${escapeHtml(days)}</td><td>${escapeHtml(time)}</td><td>${escapeHtml(audience)}</td></tr>`).join('\n');
  const photo = slug === 'volnaya-borba' ? '/assets/gallery/wrestling-tournament.jpg' : teamPhoto;
  const photoAlt = slug === 'volnaya-borba' ? 'Поединок на турнире по вольной борьбе' : `Участники клуба ${name} в зале`;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  ${metadata(`${heading} — ${name}`, description, `${origin}${sectionUrl(slug)}`, `${origin}${photo}`)}
  <link rel="icon" href="/favicon.ico">
  <link rel="stylesheet" href="/assets/site-pages.css">
</head><body class="club-page">
${clubHeader()}
<main class="club-page-main">
  <nav aria-label="Навигация по разделам"><a href="/#directions">← Все направления</a></nav>
  <div class="club-page-hero">
    <div><h1>${escapeHtml(heading)}</h1>
      <p class="club-page-intro">Группы ${escapeHtml(age)}</p>
      <p>${escapeHtml(intro + remainder)}</p>
      <p class="club-page-actions"><a class="club-page-button" href="/#contacts">Записаться на тренировку</a></p>
    </div>
    <img src="${photo}" alt="${escapeHtml(photoAlt)}" width="800" height="600">
  </div>
  <section class="club-page-panel"><h2>Расписание тренировок</h2>
    <table class="club-page-schedule"><caption>${escapeHtml(group.name)}</caption>
      <thead><tr><th scope="col">Дни</th><th scope="col">Время</th><th scope="col">Группа</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>
  ${clubContact()}
  <section class="club-page-panel"><h2>Другие направления</h2><ul class="club-page-links">${links(slug)}</ul></section>
</main></body></html>`;
}

export function installSitePages(app, config) {
  const origin = config.siteUrl || 'https://antipov.team';
  const readLanding = () => renderLanding(readFileSync(path.join(config.publicDir, 'index.html'), 'utf8'), origin);
  const landing = config.production ? readLanding() : null;
  const pages = new Map(training.directions.map((direction) => [direction.slug, renderSection(direction, origin)]));
  const urls = ['/', ...training.directions.map(({ slug }) => sectionUrl(slug))];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${escapeHtml(origin + url)}</loc></url>`).join('\n')}\n</urlset>\n`;

  app.get('/', (_req, res) => res.type('html').send(landing ?? readLanding()));
  app.get('/index.html', (_req, res) => res.redirect(301, '/'));
  app.get('/robots.txt', (_req, res) => res.type('text').send(`User-agent: *\nDisallow: /api/admin/\nSitemap: ${origin}/sitemap.xml\n`));
  app.get('/sitemap.xml', (_req, res) => res.type('xml').send(sitemap));
  app.get('/sekcii/:slug/', (req, res) => {
    const page = pages.get(req.params.slug);
    if (!page) return res.sendStatus(404);
    if (!req.path.endsWith('/')) return res.redirect(301, sectionUrl(req.params.slug));
    return res.type('html').send(page);
  });
}
