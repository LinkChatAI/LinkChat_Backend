import { Router, Request, Response } from 'express';
import { getRoomBySlugOrCode, getPublicRooms } from '../services/roomService.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const router = Router();

/** Static marketing/content URLs for sitemap (keep in sync with frontend routes) */
const STATIC_SEO_PATHS: { path: string; changefreq: string; priority: string }[] = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/create', changefreq: 'daily', priority: '0.8' },
  { path: '/join', changefreq: 'daily', priority: '0.8' },
  { path: '/linkchat-about', changefreq: 'monthly', priority: '0.6' },
  { path: '/linkchat-how-it-works', changefreq: 'monthly', priority: '0.6' },
  { path: '/linkchat-pricing', changefreq: 'monthly', priority: '0.7' },
  { path: '/linkchat-contact', changefreq: 'yearly', priority: '0.4' },
  { path: '/linkchat-create-room', changefreq: 'daily', priority: '0.8' },
  { path: '/linkchat-join-room', changefreq: 'daily', priority: '0.8' },
  { path: '/blog', changefreq: 'weekly', priority: '0.7' },
  { path: '/tools', changefreq: 'weekly', priority: '0.7' },
  { path: '/tools/chat-link-generator', changefreq: 'weekly', priority: '0.8' },
  { path: '/tools/website-engagement-tester', changefreq: 'weekly', priority: '0.7' },
  { path: '/tools/support-response-time-calculator', changefreq: 'weekly', priority: '0.7' },
  { path: '/linkchat-iran-war', changefreq: 'daily', priority: '0.7' },
  { path: '/linkchat-rivian-r2', changefreq: 'weekly', priority: '0.7' },
  { path: '/linkchat-jp', changefreq: 'monthly', priority: '0.7' },
  // Blog posts
  { path: '/blog/chatgpt-alternative-for-group-chat', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/create-free-temporary-chat-room', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/secure-private-chat-without-signup', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/chat-rooms-for-teams-and-events', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/qr-code-chat-rooms-explained', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/why-ephemeral-chat-is-better', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/free-instant-file-sharing-without-account', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/best-chat-apps-no-phone-number-2026', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/linkchat-vs-whatsapp-telegram-discord-slack', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/add-chat-widget-to-shopify-5-minutes', changefreq: 'monthly', priority: '0.7' },
  { path: '/blog/lightweight-chat-for-nextjs', changefreq: 'monthly', priority: '0.7' },
  { path: '/blog/securing-client-communications-freelancers', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/whatsapp-link-generator-shopify-ecommerce', changefreq: 'monthly', priority: '0.7' },
  { path: '/blog/whatsapp-link-generator-prefilled-message', changefreq: 'monthly', priority: '0.7' },
  { path: '/blog/click-to-chat-link-business-card', changefreq: 'monthly', priority: '0.7' },
  { path: '/blog/temporary-chat-room-no-signup', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/secure-anonymous-chat-link-generator', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/add-live-chat-react-app', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/free-live-chat-wordpress', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/line-chat-link-generator-japan', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/ichiji-chat-room-musen-toroku', changefreq: 'monthly', priority: '0.6' },
  { path: '/blog/google-gemni-gemini-ai-chat-free-alternative', changefreq: 'weekly', priority: '0.7' },
  { path: '/blog/rivian-r2-2026-price-specs-release', changefreq: 'weekly', priority: '0.7' },
  { path: '/blog/gta-6-release-date-map-lucia-price-delay', changefreq: 'weekly', priority: '0.7' },
  { path: '/blog/2024-nissan-gtr-mclaren-senna-gtr-supercars', changefreq: 'weekly', priority: '0.6' },
  { path: '/blog/us-iran-war-news-live-discussion-chat', changefreq: 'daily', priority: '0.7' },
  { path: '/blog/seo-services-free-tools-agency-chat', changefreq: 'monthly', priority: '0.6' },
];

// Sitemap.xml
router.get('/sitemap.xml', async (req: Request, res: Response): Promise<void> => {
  try {
    const publicRooms = await getPublicRooms(100);
    const baseUrl = env.BASE_URL;

    const urls = STATIC_SEO_PATHS.map(
      ({ path, changefreq, priority }) =>
        `<url><loc>${baseUrl}${path}</loc><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`
    );

    publicRooms.forEach((room) => {
      const path = room.slug || room.code;
      urls.push(
        `<url><loc>${baseUrl}/r/${path}</loc><changefreq>hourly</changefreq><priority>0.8</priority></url>`
      );
    });

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;

    res.set('Content-Type', 'application/xml');
    res.send(sitemap);
  } catch (error: any) {
    // Handle database connection errors
    if (error instanceof Error && error.message === 'Database connection not available') {
      logger.error('Database not available when generating sitemap');
      res.status(503).send('Service temporarily unavailable');
      return;
    }
    
    logger.error('Error generating sitemap', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).send('Error generating sitemap');
  }
});

// Robots.txt
router.get('/robots.txt', (req: Request, res: Response): void => {
  const baseUrl = env.BASE_URL;
  const robots = `User-agent: *
Allow: /
Allow: /r/
Disallow: /api/
Disallow: /admin/

Sitemap: ${baseUrl}/sitemap.xml
`;
  res.set('Content-Type', 'text/plain');
  res.send(robots);
});

// Shareable preview page for social media crawlers
router.get('/share/:slugOrCode', async (req: Request, res: Response): Promise<void> => {
  try {
    const { slugOrCode } = req.params;
    const room = await getRoomBySlugOrCode(slugOrCode);

    if (!room || new Date() > room.expiresAt) {
      res.status(404).send('Room not found or expired');
      return;
    }

    const title = room.name
      ? `${room.name} — LinkChat`
      : `Room ${room.code} — LinkChat`;
    const description = room.name
      ? `Join ${room.name} on LinkChat — instant temporary chat room. Room code: ${room.code}`
      : `Join room ${room.code} on LinkChat — instant temporary chat rooms. Create a room, share a code, join from any device.`;
    const image = `${env.BASE_URL}${env.DEFAULT_OG_IMAGE}`;
    const url = `${env.BASE_URL}/r/${room.slug || room.code}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}">
  
  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${image}">
  
  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:url" content="${url}">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${image}">
  
  <link rel="canonical" href="${url}">
  
  <meta http-equiv="refresh" content="0;url=${url}">
</head>
<body>
  <p>Redirecting to <a href="${url}">${url}</a></p>
</body>
</html>`;

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (error: any) {
    // Handle database connection errors
    if (error instanceof Error && error.message === 'Database connection not available') {
      logger.error('Database not available when generating share page');
      res.status(503).send('Service temporarily unavailable');
      return;
    }
    
    logger.error('Error generating share page', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).send('Error generating share page');
  }
});


export default router;
