import { Response } from 'express';
import { z } from 'zod';
import { AdminRequest } from '../middleware/adminAuth.js';
import {
  getSettings,
  updateSettings,
  getDefaultSettings,
  invalidateSettingsCache,
} from '../services/adminSettingsService.js';
import { logger } from '../utils/logger.js';

/**
 * Bounds are enforced here as well as in the Mongoose schema. The upper limits
 * are deliberately conservative — these values feed room lifetime and upload
 * size, so a fat-fingered entry is a cost event, not just a UX bug.
 */
const settingsSchema = z
  .object({
    // 1 minute .. 30 days
    defaultRoomExpiryHours: z.number().min(0.0167).max(720),
    autoVanishHours: z.number().min(0.0167).max(720),
    // 0 = unlimited
    maxParticipantsPerRoom: z.number().int().min(0).max(100000),
    // 1 minute .. 24 hours
    adminLeaveGraceMinutes: z.number().int().min(1).max(1440),
    maxFileSizeMb: z.number().int().min(1).max(2048),
    fileUploadsEnabled: z.boolean(),
    roomCreationEnabled: z.boolean(),
    maintenanceMode: z.boolean(),
    maintenanceMessage: z.string().max(300),
  })
  .partial();

/** GET /admin/settings — current values plus the defaults they fall back to. */
export const getSettingsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const settings = await getSettings();
    res.json({ settings, defaults: getDefaultSettings() });
  } catch (error: unknown) {
    logger.error('Error fetching admin settings', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
};

/** PUT /admin/settings — partial update of the singleton. */
export const updateSettingsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const parsed = settingsSchema.parse(req.body ?? {});
    if (Object.keys(parsed).length === 0) {
      res.status(400).json({ error: 'No settings provided' });
      return;
    }

    const settings = await updateSettings(parsed, req.adminId || 'unknown');
    res.json({ settings, defaults: getDefaultSettings() });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Invalid settings',
        details: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
      });
      return;
    }
    logger.error('Error updating admin settings', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to update settings' });
  }
};

/** POST /admin/settings/reset — drop overrides and fall back to env defaults. */
export const resetSettingsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const settings = await updateSettings(getDefaultSettings(), req.adminId || 'unknown');
    invalidateSettingsCache();
    res.json({ settings, defaults: getDefaultSettings() });
  } catch (error: unknown) {
    logger.error('Error resetting admin settings', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to reset settings' });
  }
};
