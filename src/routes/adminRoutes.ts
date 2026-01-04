import { Router } from 'express';
import {
  getTotalRooms,
  getActiveRooms,
  getLockedRooms,
  getAutoVanishRooms,
  getVanishedToday,
  getUsersOnline,
  getUsersInLockedRooms,
  getRoomsExpiringInNextHour,
  getRoomsExpiringToday,
  getDashboardInsights,
  getActiveRoomsList,
  getLockedRoomsList,
  vanishRoom,
} from '../controllers/adminController.js';
import { authenticateAdmin } from '../middleware/adminAuth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { auditAdminAction } from '../middleware/adminAudit.js';
import { cacheAdminResponse } from '../middleware/adminCache.js';
import { protectQuery, protectDashboardQuery } from '../middleware/queryProtection.js';

const router = Router();

// All admin routes require authentication
router.use(authenticateAdmin);

// Individual endpoints with caching, rate limiting, audit, and query protection
router.get(
  '/insights/total-rooms',
  rateLimiter('adminInsight'),
  auditAdminAction('get_total_rooms'),
  cacheAdminResponse({ ttl: 60 }), // Cache for 60 seconds
  protectQuery({ maxResultLimit: 1, defaultLimit: 1 }),
  getTotalRooms
);

router.get(
  '/insights/active-rooms',
  rateLimiter('adminInsight'),
  auditAdminAction('get_active_rooms'),
  cacheAdminResponse({ ttl: 30 }), // Cache for 30 seconds
  protectQuery({ maxResultLimit: 1, defaultLimit: 1 }),
  getActiveRooms
);

router.get(
  '/insights/locked-rooms',
  rateLimiter('adminInsight'),
  auditAdminAction('get_locked_rooms'),
  cacheAdminResponse({ ttl: 30 }),
  protectQuery({ maxResultLimit: 1, defaultLimit: 1 }),
  getLockedRooms
);

router.get(
  '/insights/auto-vanish-rooms',
  rateLimiter('adminInsight'),
  auditAdminAction('get_auto_vanish_rooms'),
  cacheAdminResponse({ ttl: 30 }),
  protectQuery({ maxResultLimit: 1, defaultLimit: 1 }),
  getAutoVanishRooms
);

router.get(
  '/insights/vanished-today',
  rateLimiter('adminInsight'),
  auditAdminAction('get_vanished_today'),
  cacheAdminResponse({ ttl: 60 }),
  protectQuery({ maxResultLimit: 1, defaultLimit: 1 }),
  getVanishedToday
);

router.get(
  '/insights/users-online',
  rateLimiter('adminInsight'),
  auditAdminAction('get_users_online'),
  cacheAdminResponse({ ttl: 10 }), // Short cache for real-time data
  protectQuery({ maxResultLimit: 1, defaultLimit: 1 }),
  getUsersOnline
);

router.get(
  '/insights/users-in-locked-rooms',
  rateLimiter('adminInsight'),
  auditAdminAction('get_users_in_locked_rooms'),
  cacheAdminResponse({ ttl: 30 }),
  protectQuery({ maxResultLimit: 1, defaultLimit: 1 }),
  getUsersInLockedRooms
);

router.get(
  '/insights/rooms-expiring-next-hour',
  rateLimiter('adminInsight'),
  auditAdminAction('get_rooms_expiring_next_hour'),
  cacheAdminResponse({ ttl: 60 }),
  protectQuery({ maxResultLimit: 1, defaultLimit: 1 }),
  getRoomsExpiringInNextHour
);

router.get(
  '/insights/rooms-expiring-today',
  rateLimiter('adminInsight'),
  auditAdminAction('get_rooms_expiring_today'),
  cacheAdminResponse({ ttl: 60 }),
  protectQuery({ maxResultLimit: 1, defaultLimit: 1 }),
  getRoomsExpiringToday
);

// Combined dashboard endpoint with enhanced protection
router.get(
  '/insights/dashboard',
  rateLimiter('adminDashboard'),
  auditAdminAction('get_dashboard_insights'),
  protectDashboardQuery(), // Circuit breaker protection
  cacheAdminResponse({ ttl: 15 }), // Short cache for dashboard
  protectQuery({ timeoutMs: 15000 }), // 15 second timeout
  getDashboardInsights
);

// Room management endpoints
router.get(
  '/rooms/active',
  rateLimiter('adminInsight'),
  auditAdminAction('get_active_rooms_list'),
  cacheAdminResponse({ ttl: 10 }), // Short cache for real-time data
  getActiveRoomsList
);

router.get(
  '/rooms/locked',
  rateLimiter('adminInsight'),
  auditAdminAction('get_locked_rooms_list'),
  cacheAdminResponse({ ttl: 10 }), // Short cache for real-time data
  getLockedRoomsList
);

router.post(
  '/rooms/:roomCode/vanish',
  rateLimiter('adminAction'), // 10 requests per minute for actions
  auditAdminAction('vanish_room', { roomCode: ':roomCode' }),
  vanishRoom
);

export default router;

