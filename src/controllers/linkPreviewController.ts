import { Request, Response } from 'express';
import { fetchLinkPreview } from '../services/linkPreviewService.js';

export const getLinkPreviewHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!url) {
      res.status(400).json({ error: 'URL is required' });
      return;
    }

    const clientKey = req.ip || 'unknown';
    const preview = await fetchLinkPreview(url, clientKey);

    if (!preview) {
      res.status(404).json({ error: 'Preview not available' });
      return;
    }

    res.json(preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch preview';
    if (message.includes('rate limit')) {
      res.status(429).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
};
