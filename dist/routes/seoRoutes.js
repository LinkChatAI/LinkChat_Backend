import { Router } from 'express';
import { getRoomBySlugOrCode, getPublicRooms } from '../services/roomService.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
const router = Router();
// Sitemap.xml
router.get('/sitemap.xml', async (req, res) => {
    try {
        const publicRooms = await getPublicRooms(100);
        const baseUrl = env.BASE_URL;
        const urls = [
            `<url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
        ];
        publicRooms.forEach((room) => {
            const path = room.slug || room.code;
            urls.push(`<url><loc>${baseUrl}/r/${path}</loc><changefreq>hourly</changefreq><priority>0.8</priority></url>`);
        });
        const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
        res.set('Content-Type', 'application/xml');
        res.send(sitemap);
    }
    catch (error) {
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
router.get('/robots.txt', (req, res) => {
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
router.get('/share/:slugOrCode', async (req, res) => {
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
    }
    catch (error) {
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
//# sourceMappingURL=seoRoutes.js.map