import { Router } from 'express';
import { requireAdminRole } from '../middleware/adminRoleAuth.js';
import { auditAdminUserAction } from '../middleware/adminUserAudit.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import {
  listUsersHandler,
  getUserDetailHandler,
  changeUserStatusHandler,
  verifyUserHandler,
  changeUserRoleHandler,
} from '../controllers/adminUserController.js';

const router = Router();

router.use(requireAdminRole);
router.use(rateLimiter('adminAction'));

router.get('/', auditAdminUserAction('RBAC_USERS_LIST'), listUsersHandler);
router.get('/:id', auditAdminUserAction('RBAC_USER_DETAIL'), getUserDetailHandler);
router.patch('/:id/status', auditAdminUserAction('RBAC_USER_STATUS_CHANGE'), changeUserStatusHandler);
router.patch('/:id/verify', auditAdminUserAction('RBAC_USER_VERIFY'), verifyUserHandler);
router.patch('/:id/role', auditAdminUserAction('RBAC_USER_ROLE_CHANGE'), changeUserRoleHandler);

export default router;
