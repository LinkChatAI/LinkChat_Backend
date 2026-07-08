import { Router } from 'express';
import { requireAdminRole } from '../middleware/adminRoleAuth.js';
import { auditAdminUserAction } from '../middleware/adminUserAudit.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import {
  listAllPlansHandler,
  createPlanHandler,
  updatePlanHandler,
  setPlanActiveHandler,
  deletePlanHandler,
} from '../controllers/planController.js';
import {
  grantSubscriptionHandler,
  recordPaymentHandler,
  confirmPurchaseRequestHandler,
  cancelSubscriptionHandler,
  renewSubscriptionHandler,
  listAllSubscriptionsHandler,
  listPendingPurchaseRequestsHandler,
  listAllPaymentsHandler,
} from '../controllers/subscriptionController.js';
import { grantCreditsHandler, listCreditTransactionsHandler } from '../controllers/creditController.js';

const router = Router();

// New per-user RBAC gate — distinct from the legacy shared-secret ops dashboard.
router.use(requireAdminRole);
router.use(rateLimiter('adminAction'));

// Plans
router.get('/plans', auditAdminUserAction('BILLING_PLANS_LIST'), listAllPlansHandler);
router.post('/plans', auditAdminUserAction('BILLING_PLAN_CREATE'), createPlanHandler);
router.put('/plans/:id', auditAdminUserAction('BILLING_PLAN_UPDATE'), updatePlanHandler);
router.patch('/plans/:id/status', auditAdminUserAction('BILLING_PLAN_STATUS_CHANGE'), setPlanActiveHandler);
router.delete('/plans/:id', auditAdminUserAction('BILLING_PLAN_DELETE'), deletePlanHandler);

// Subscriptions
router.get('/subscriptions', auditAdminUserAction('BILLING_SUBSCRIPTIONS_LIST'), listAllSubscriptionsHandler);
router.get('/purchase-requests', auditAdminUserAction('BILLING_PURCHASE_REQUESTS_LIST'), listPendingPurchaseRequestsHandler);
router.post('/grant-subscription', auditAdminUserAction('BILLING_SUBSCRIPTION_GRANT'), grantSubscriptionHandler);
router.post('/record-payment', auditAdminUserAction('BILLING_PAYMENT_RECORD'), recordPaymentHandler);
router.post('/purchase-requests/:id/confirm', auditAdminUserAction('BILLING_PURCHASE_REQUEST_CONFIRM'), confirmPurchaseRequestHandler);
router.post('/subscriptions/:id/cancel', auditAdminUserAction('BILLING_SUBSCRIPTION_CANCEL'), cancelSubscriptionHandler);
router.post('/subscriptions/:id/renew', auditAdminUserAction('BILLING_SUBSCRIPTION_RENEW'), renewSubscriptionHandler);

// Payments
router.get('/payments', auditAdminUserAction('BILLING_PAYMENTS_LIST'), listAllPaymentsHandler);

// Credits
router.get('/credit-transactions', auditAdminUserAction('BILLING_CREDIT_TRANSACTIONS_LIST'), listCreditTransactionsHandler);
router.post('/grant-credits', auditAdminUserAction('BILLING_CREDITS_GRANT'), grantCreditsHandler);

export default router;
