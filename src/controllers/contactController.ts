import { Request, Response } from 'express';
import { ContactSubmissionModel } from '../models/ContactSubmission.js';
import { logger } from '../utils/logger.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { AdminRequest } from '../middleware/adminAuth.js';
import { notifySalesTeam } from '../services/salesNotifyEmail.js';

// Spam detection patterns
const SPAM_PATTERNS = [
  /\b(viagra|cialis|casino|poker|loan|debt|credit|buy now|click here|limited time)\b/gi,
  /\b(http:\/\/|https:\/\/|www\.)[^\s]{10,}/gi, // Multiple URLs
  /\b[A-Z]{10,}/g, // All caps words
  /(.)\1{10,}/g, // Repeated characters (aaaaa)
];

// Honeypot field name (should be hidden from users but filled by bots)
const HONEYPOT_FIELD = '_website';

interface ContactSubmissionRequest {
  name: string;
  email: string;
  message: string;
  category?: 'general' | 'support' | 'feedback' | 'bug' | 'feature' | 'other';
  [key: string]: any; // For honeypot field
}

const detectSpam = (data: ContactSubmissionRequest, ipAddress: string): { isSpam: boolean; reason?: string } => {
  // Check honeypot field (should be empty for real users)
  if (data[HONEYPOT_FIELD] && data[HONEYPOT_FIELD].trim() !== '') {
    return { isSpam: true, reason: 'Honeypot field filled' };
  }

  // Check for spam patterns in message
  const messageLower = (data.message || '').toLowerCase();
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(messageLower)) {
      return { isSpam: true, reason: 'Contains spam patterns' };
    }
  }

  // Check for excessive URLs
  const urlMatches = messageLower.match(/https?:\/\//g);
  if (urlMatches && urlMatches.length > 3) {
    return { isSpam: true, reason: 'Too many URLs in message' };
  }

  // Check for suspicious email patterns
  if (data.email) {
    const emailLower = data.email.toLowerCase();
    // Multiple @ signs
    if ((emailLower.match(/@/g) || []).length > 1) {
      return { isSpam: true, reason: 'Invalid email format' };
    }
    // Suspicious domains
    const suspiciousDomains = ['tempmail', 'throwaway', '10minutemail', 'guerrillamail'];
    if (suspiciousDomains.some(domain => emailLower.includes(domain))) {
      // This is a warning but not necessarily spam - just log it
      logger.info('Potentially suspicious email domain', { email: data.email, ip: ipAddress });
    }
  }

  return { isSpam: false };
};

const checkRateLimit = async (ipAddress: string, email: string): Promise<{ allowed: boolean; reason?: string }> => {
  const redis = getRedisClient();
  
  if (!redis || !isRedisAvailable()) {
    // If Redis is not available, allow request but log warning
    logger.warn('Rate limiting unavailable - Redis not connected');
    return { allowed: true };
  }

  try {
    // Check IP-based rate limit: 5 submissions per hour
    const ipKey = `contact:rate_limit:ip:${ipAddress}`;
    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) {
      await redis.expire(ipKey, 3600); // 1 hour
    }
    if (ipCount > 5) {
      return { allowed: false, reason: 'Too many submissions from this IP. Please try again later.' };
    }

    // Check email-based rate limit: 3 submissions per 24 hours
    const emailKey = `contact:rate_limit:email:${email.toLowerCase()}`;
    const emailCount = await redis.incr(emailKey);
    if (emailCount === 1) {
      await redis.expire(emailKey, 86400); // 24 hours
    }
    if (emailCount > 3) {
      return { allowed: false, reason: 'Too many submissions with this email. Please try again tomorrow.' };
    }

    return { allowed: true };
  } catch (error: any) {
    logger.error('Rate limit check failed', { error: error instanceof Error ? error.message : String(error) });
    // Fail open - allow request if rate limiting fails
    return { allowed: true };
  }
};

export const submitContact = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, message, category } = req.body as ContactSubmissionRequest;
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    if (name.trim().length > 200) {
      res.status(400).json({ error: 'Name must be 200 characters or less' });
      return;
    }

    if (!email || typeof email !== 'string' || email.trim().length === 0) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      res.status(400).json({ error: 'Invalid email format' });
      return;
    }

    if (email.trim().length > 255) {
      res.status(400).json({ error: 'Email must be 255 characters or less' });
      return;
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    if (message.trim().length > 5000) {
      res.status(400).json({ error: 'Message must be 5000 characters or less' });
      return;
    }

    if (message.trim().length < 10) {
      res.status(400).json({ error: 'Message must be at least 10 characters long' });
      return;
    }

    // Validate category if provided
    const validCategories = ['general', 'support', 'feedback', 'bug', 'feature', 'sales', 'other'];
    if (category && !validCategories.includes(category)) {
      res.status(400).json({ error: 'Invalid category' });
      return;
    }

    // Check rate limits
    const rateLimitCheck = await checkRateLimit(ipAddress, email);
    if (!rateLimitCheck.allowed) {
      res.status(429).json({ 
        error: rateLimitCheck.reason || 'Too many requests. Please try again later.',
        retryAfter: 3600 
      });
      return;
    }

    // Detect spam
    const spamCheck = detectSpam(req.body, ipAddress);
    
    // Create submission (mark as spam but still save for review)
    const submission = await ContactSubmissionModel.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      message: message.trim(),
      category: category || 'general',
      ipAddress,
      userAgent,
      isSpam: spamCheck.isSpam,
      spamReason: spamCheck.reason,
    });

    if (spamCheck.isSpam) {
      logger.warn('Spam contact submission detected', {
        submissionId: submission._id,
        email: submission.email,
        ip: ipAddress,
        reason: spamCheck.reason,
      });
    }

    // Always return success to user (don't reveal spam detection)
    res.status(201).json({
      success: true,
      message: 'Thank you for your submission. We will get back to you soon.',
      submissionId: submission._id.toString(),
    });
  } catch (error: any) {
    logger.error('Error submitting contact form', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Don't reveal internal errors to users
    res.status(500).json({
      error: 'Failed to submit contact form. Please try again later.',
    });
  }
};

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

const normalizePhone = (phone: string): string => phone.replace(/\D/g, '');

const checkSalesRateLimit = async (ipAddress: string, phone: string): Promise<{ allowed: boolean; reason?: string }> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) {
    return { allowed: true };
  }

  try {
    const ipKey = `contact:sales:ip:${ipAddress}`;
    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) {
      await redis.expire(ipKey, 3600);
    }
    if (ipCount > 8) {
      return { allowed: false, reason: 'Too many requests. Please try again in an hour.' };
    }

    const phoneKey = `contact:sales:phone:${normalizePhone(phone)}`;
    const phoneCount = await redis.incr(phoneKey);
    if (phoneCount === 1) {
      await redis.expire(phoneKey, 86400);
    }
    if (phoneCount > 3) {
      return { allowed: false, reason: 'We have already received your request. Our team will contact you soon.' };
    }

    return { allowed: true };
  } catch (error: unknown) {
    logger.error('Sales rate limit check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true };
  }
};

export const submitSalesInquiry = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, phone, plan, email, notes } = req.body as {
      name?: string;
      phone?: string;
      plan?: string;
      email?: string;
      notes?: string;
      [key: string]: unknown;
    };
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    if (req.body[HONEYPOT_FIELD] && String(req.body[HONEYPOT_FIELD]).trim() !== '') {
      res.status(201).json({
        success: true,
        message: 'Thank you for your interest. Our sales team will reach out to you shortly.',
      });
      return;
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Please enter your full name.' });
      return;
    }
    if (name.trim().length > 200) {
      res.status(400).json({ error: 'Name must be 200 characters or less.' });
      return;
    }

    if (!phone || typeof phone !== 'string' || phone.trim().length === 0) {
      res.status(400).json({ error: 'Please enter a valid contact number.' });
      return;
    }
    const phoneTrimmed = phone.trim();
    const phoneDigits = normalizePhone(phoneTrimmed);
    if (!INDIAN_MOBILE_REGEX.test(phoneDigits)) {
      res.status(400).json({ error: 'Please enter a valid 10-digit mobile number starting with 6, 7, 8, or 9.' });
      return;
    }

    const planName = (typeof plan === 'string' && plan.trim()) ? plan.trim() : 'Premium';
    if (planName.length > 50) {
      res.status(400).json({ error: 'Invalid plan selection.' });
      return;
    }

    let emailForDb = '';
    if (email && typeof email === 'string' && email.trim()) {
      const emailTrimmed = email.trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(emailTrimmed)) {
        res.status(400).json({ error: 'Please enter a valid email address, or leave it blank.' });
        return;
      }
      emailForDb = emailTrimmed.toLowerCase();
    } else {
      emailForDb = `sales-inquiry+${normalizePhone(phoneTrimmed)}@linkchat.in`;
    }

    const notesText = typeof notes === 'string' ? notes.trim().slice(0, 500) : '';
    const message = [
      `Plan interest: ${planName}`,
      `Contact number: ${phoneTrimmed}`,
      notesText ? `Additional notes: ${notesText}` : '',
      'Source: Pricing page subscription form',
    ]
      .filter(Boolean)
      .join('\n');

    const rateLimitCheck = await checkSalesRateLimit(ipAddress, phoneTrimmed);
    if (!rateLimitCheck.allowed) {
      res.status(429).json({
        error: rateLimitCheck.reason || 'Too many requests. Please try again later.',
        retryAfter: 3600,
      });
      return;
    }

    const submission = await ContactSubmissionModel.create({
      name: name.trim(),
      email: emailForDb,
      phone: phoneTrimmed,
      plan: planName,
      message,
      category: 'sales',
      ipAddress,
      userAgent,
      isSpam: false,
    });

    notifySalesTeam({
      name: name.trim(),
      phone: phoneTrimmed,
      plan: planName,
      email: email && typeof email === 'string' ? email.trim() : undefined,
      notes: notesText || undefined,
    }).catch((err) => {
      logger.warn('Sales notification email failed', {
        error: err instanceof Error ? err.message : String(err),
        submissionId: submission._id,
      });
    });

    res.status(201).json({
      success: true,
      message:
        'Thank you for your interest in LinkChat. Our sales team will call you shortly at the number you provided.',
      submissionId: submission._id.toString(),
    });
  } catch (error: unknown) {
    logger.error('Error submitting sales inquiry', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      error: 'We could not submit your request right now. Please try again or email linkchat.office@gmail.com.',
    });
  }
};

export const getContactSubmissions = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100); // Max 100 per page
    const category = req.query.category as string;
    const includeSpam = req.query.includeSpam === 'true';
    const skip = (page - 1) * limit;

    // Build query
    const query: any = {};
    
    if (category && category !== 'all') {
      query.category = category;
    }

    if (!includeSpam) {
      query.isSpam = { $ne: true };
    }

    // Get total count
    const total = await ContactSubmissionModel.countDocuments(query);

    // Get submissions
    const submissions = await ContactSubmissionModel.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-__v')
      .lean();

    res.json({
      submissions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    logger.error('Error fetching contact submissions', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch contact submissions' });
  }
};

/** DELETE /api/admin/contact/submissions/:id — permanently remove one submission. */
export const deleteContactSubmission = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const result = await ContactSubmissionModel.findByIdAndDelete(id);
    if (!result) {
      res.status(404).json({ error: 'Submission not found' });
      return;
    }
    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error deleting contact submission', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to delete contact submission' });
  }
};

