import { getRoomBySlugOrCode } from '../services/roomService.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
export const getShareMetaHandler = async (req, res) => {
    try {
        const { slugOrCode } = req.params;
        const room = await getRoomBySlugOrCode(slugOrCode);
        if (!room || new Date() > room.expiresAt) {
            res.status(404).json({ error: 'Room not found or expired' });
            return;
        }
        const title = room.name
            ? `${room.name} — LinkChat`
            : `Room ${room.code} — LinkChat`;
        const description = room.name
            ? `Join ${room.name} on LinkChat — instant temporary chat room. Room code: ${room.code}`
            : `Join room ${room.code} on LinkChat — instant temporary chat rooms.`;
        res.json({
            title,
            description,
            image: `${env.BASE_URL}${env.DEFAULT_OG_IMAGE}`,
            url: `${env.BASE_URL}/r/${room.slug || room.code}`,
            siteName: env.SITE_TITLE,
        });
    }
    catch (error) {
        // Handle database connection errors
        if (error instanceof Error && error.message === 'Database connection not available') {
            logger.error('Database not available when generating share metadata');
            res.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
            return;
        }
        logger.error('Error generating share metadata', { error: error instanceof Error ? error.message : String(error) });
        res.status(500).json({ error: 'Failed to generate metadata' });
    }
};
//# sourceMappingURL=seoController.js.map