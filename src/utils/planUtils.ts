import { UserPlan } from '../types/index.js';

const PREMIUM_PLANS: UserPlan[] = ['premium', 'pro', 'enterprise'];

export const isPremiumPlan = (plan: UserPlan | undefined): boolean => {
  return !!plan && PREMIUM_PLANS.includes(plan);
};

export const isProOrAbove = (plan: UserPlan | undefined): boolean => {
  return plan === 'pro' || plan === 'enterprise';
};
