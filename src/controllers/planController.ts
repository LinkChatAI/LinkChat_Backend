import { Response } from 'express';
import { Request } from 'express';
import { z } from 'zod';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan.js';
import { AdminUserRequest } from '../middleware/adminRoleAuth.js';
import { logger } from '../utils/logger.js';

/** Public: active plans only — used by the pricing page. */
export const listActivePlansHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const plans = await SubscriptionPlanModel.find({ isActive: true }).sort({ price: 1 }).lean();
    res.json({ plans });
  } catch (error) {
    logger.error('Failed to list active plans', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to list plans' });
  }
};

/** Admin: every plan, active or not. */
export const listAllPlansHandler = async (_req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const plans = await SubscriptionPlanModel.find().sort({ createdAt: -1 }).lean();
    res.json({ plans });
  } catch (error) {
    logger.error('Failed to list all plans', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to list plans' });
  }
};

const slugify = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const createPlanSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).optional(),
  tier: z.enum(['free', 'premium', 'pro', 'enterprise']),
  price: z.number().int().min(0),
  currency: z.string().length(3).optional(),
  billingPeriod: z.enum(['monthly', 'yearly', 'one_time']),
  creditsIncluded: z.number().int().min(0).optional(),
  features: z.array(z.string().max(200)).optional(),
});

export const createPlanHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const body = createPlanSchema.parse(req.body);
    const slug = slugify(body.name);

    const existing = await SubscriptionPlanModel.findOne({ slug });
    if (existing) {
      res.status(409).json({ error: 'A plan with this name already exists' });
      return;
    }

    const plan = await SubscriptionPlanModel.create({
      ...body,
      slug,
      currency: body.currency || 'INR',
      creditsIncluded: body.creditsIncluded || 0,
      features: body.features || [],
      isActive: true,
      createdBy: req.adminUser!.userId,
    });

    res.status(201).json({ plan });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid plan data', details: error.issues });
      return;
    }
    logger.error('Failed to create plan', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to create plan' });
  }
};

const updatePlanSchema = createPlanSchema.partial();

export const updatePlanHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const body = updatePlanSchema.parse(req.body);

    const plan = await SubscriptionPlanModel.findById(id);
    if (!plan) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }

    if (body.name && body.name !== plan.name) {
      const newSlug = slugify(body.name);
      const clash = await SubscriptionPlanModel.findOne({ slug: newSlug, _id: { $ne: plan._id } });
      if (clash) {
        res.status(409).json({ error: 'A plan with this name already exists' });
        return;
      }
      plan.slug = newSlug;
    }

    Object.assign(plan, body);
    await plan.save();

    res.json({ plan });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid plan data', details: error.issues });
      return;
    }
    logger.error('Failed to update plan', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to update plan' });
  }
};

export const setPlanActiveHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);

    const plan = await SubscriptionPlanModel.findByIdAndUpdate(id, { isActive }, { new: true });
    if (!plan) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    res.json({ plan });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'isActive must be a boolean' });
      return;
    }
    logger.error('Failed to toggle plan status', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to update plan status' });
  }
};

export const deletePlanHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const result = await SubscriptionPlanModel.findByIdAndDelete(id);
    if (!result) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete plan', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to delete plan' });
  }
};
