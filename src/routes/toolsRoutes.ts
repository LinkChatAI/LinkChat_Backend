import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger.js';

const router = Router();

const breachLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  message: { error: 'Too many breach checks. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface HibpBreachSummary {
  name: string;
  breachDate: string;
  dataClasses: string[];
}

router.get('/email-breach-check', breachLimiter, async (req: Request, res: Response): Promise<void> => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'invalid_email', message: 'Enter a valid email address.' });
    return;
  }

  const apiKey = process.env.HIBP_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: 'service_unconfigured',
      message:
        'Email breach lookup is not configured on this server. Check your email at haveibeenpwned.com directly.',
    });
    return;
  }

  try {
    const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`;
    const hibpRes = await fetch(url, {
      headers: {
        'hibp-api-key': apiKey,
        'User-Agent': 'LinkChat-Security-Tools',
      },
    });

    if (hibpRes.status === 404) {
      res.json({ breached: false, breaches: [] as HibpBreachSummary[] });
      return;
    }

    if (hibpRes.status === 429) {
      res.status(429).json({ error: 'rate_limited', message: 'Breach service is busy. Try again shortly.' });
      return;
    }

    if (!hibpRes.ok) {
      logger.warn(`HIBP API error: ${hibpRes.status} ${hibpRes.statusText}`);
      res.status(502).json({ error: 'upstream_error', message: 'Could not check breaches right now.' });
      return;
    }

    const raw = (await hibpRes.json()) as Array<{
      Name: string;
      BreachDate: string;
      DataClasses: string[];
    }>;

    const breaches: HibpBreachSummary[] = raw.map((b) => ({
      name: b.Name,
      breachDate: b.BreachDate,
      dataClasses: b.DataClasses ?? [],
    }));

    res.json({ breached: breaches.length > 0, breaches });
  } catch (err) {
    logger.error('Email breach check failed', err);
    res.status(502).json({ error: 'upstream_error', message: 'Could not check breaches right now.' });
  }
});

export default router;
