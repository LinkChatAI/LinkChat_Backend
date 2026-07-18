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
  getDebugStats,
  getRoomDetailByCode,
} from '../controllers/adminController.js';
import { getContactSubmissions, deleteContactSubmission } from '../controllers/contactController.js';
import {
  listBanners,
  createBanner,
  updateBanner,
  deleteBanner,
  listRoomBannerMappings,
  assignRoomBanner,
  unassignRoomBanner,
  setDefaultBanner,
  clearDefaultBanner,
} from '../controllers/sponsorBannerController.js';
import { getUserLocations } from '../controllers/userLocationController.js';
import {
  getAnalytics,
  getAuditLogHandler,
  getAuditSummaryHandler,
} from '../controllers/adminAnalyticsController.js';
import {
  getSettingsHandler,
  updateSettingsHandler,
  resetSettingsHandler,
} from '../controllers/adminSettingsController.js';
import {
  inspectRoom,
  moderateRoom,
  searchRooms,
} from '../controllers/adminModerationController.js';
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

// Room search + inspector + moderation actions. These sit above the '/rooms/:code'
// catch-all below for the same shadowing reason as /rooms/active and /rooms/locked:
// '/rooms/search' would otherwise be swallowed as a room whose code is "search".
router.get(
  '/rooms/search',
  rateLimiter('adminInsight'),
  auditAdminAction('search_rooms'),
  searchRooms
);

router.get(
  '/rooms/:code/inspect',
  rateLimiter('adminInsight'),
  auditAdminAction('inspect_room', { code: ':code' }),
  cacheAdminResponse({ ttl: 5 }),
  inspectRoom
);

router.post(
  '/rooms/:code/moderate',
  rateLimiter('adminAction'),
  auditAdminAction('moderate_room', { code: ':code' }),
  moderateRoom
);

// Single room lookup by code (used by the Sponsor Banner Manager) — registered after the
// literal /rooms/active and /rooms/locked routes above so it doesn't shadow them.
router.get(
  '/rooms/:code',
  rateLimiter('adminInsight'),
  auditAdminAction('get_room_detail', { code: ':code' }),
  getRoomDetailByCode
);

// ---------------------------------------------------------------------------
// Analytics, audit trail and runtime settings.
//
// All three read data the platform was already storing (UserVisit and
// AdminAction carry no TTL) and add no new write path, so they cost nothing
// beyond the query itself. Cache TTLs are set well above the dashboard's 15s
// because none of this data changes minute to minute.
// ---------------------------------------------------------------------------

router.get(
  '/analytics',
  rateLimiter('adminDashboard'),
  auditAdminAction('get_analytics'),
  cacheAdminResponse({ ttl: 300 }), // 5 min — aggregations are the priciest queries here
  getAnalytics
);

router.get(
  '/audit/log',
  rateLimiter('adminInsight'),
  auditAdminAction('get_audit_log'),
  cacheAdminResponse({ ttl: 15 }),
  getAuditLogHandler
);

router.get(
  '/audit/summary',
  rateLimiter('adminInsight'),
  auditAdminAction('get_audit_summary'),
  cacheAdminResponse({ ttl: 60 }),
  getAuditSummaryHandler
);

router.get(
  '/settings',
  rateLimiter('adminInsight'),
  auditAdminAction('get_settings'),
  getSettingsHandler
);

router.put(
  '/settings',
  rateLimiter('adminAction'),
  auditAdminAction('update_settings'),
  updateSettingsHandler
);

router.post(
  '/settings/reset',
  rateLimiter('adminAction'),
  auditAdminAction('reset_settings'),
  resetSettingsHandler
);

// Contact submissions endpoint (admin-only)
router.get(
  '/contact/submissions',
  rateLimiter('adminInsight'),
  auditAdminAction('get_contact_submissions'),
  getContactSubmissions
);

router.delete(
  '/contact/submissions/:id',
  rateLimiter('adminAction'),
  auditAdminAction('delete_contact_submission', { id: ':id' }),
  deleteContactSubmission
);

// User geolocation (approximate, IP-derived) for the admin map view
router.get(
  '/user-locations',
  rateLimiter('adminInsight'),
  auditAdminAction('get_user_locations'),
  cacheAdminResponse({ ttl: 60 }),
  getUserLocations
);

// Sponsor / event banner library — reusable assets, each assignable to many rooms
router.get(
  '/banners',
  rateLimiter('adminInsight'),
  auditAdminAction('list_banners'),
  listBanners
);

router.post(
  '/banners',
  rateLimiter('adminAction'),
  auditAdminAction('create_banner'),
  createBanner
);

router.put(
  '/banners/:id',
  rateLimiter('adminAction'),
  auditAdminAction('update_banner', { id: ':id' }),
  updateBanner
);

router.delete(
  '/banners/:id',
  rateLimiter('adminAction'),
  auditAdminAction('delete_banner', { id: ':id' }),
  deleteBanner
);

// Room <-> banner assignments — the single place to see/manage every room's banner
router.get(
  '/room-banners',
  rateLimiter('adminInsight'),
  auditAdminAction('list_room_banner_mappings'),
  listRoomBannerMappings
);

router.put(
  '/room-banners/:roomCode',
  rateLimiter('adminAction'),
  auditAdminAction('assign_room_banner', { roomCode: ':roomCode' }),
  assignRoomBanner
);

router.delete(
  '/room-banners/:roomCode',
  rateLimiter('adminAction'),
  auditAdminAction('unassign_room_banner', { roomCode: ':roomCode' }),
  unassignRoomBanner
);

// Platform-wide default banner — the fallback shown in any room with no room-specific
// assignment (existing rooms and every room created afterward). A separate resource from
// /room-banners/* since it is room-agnostic, not a per-room mapping.
router.put(
  '/default-banner',
  rateLimiter('adminAction'),
  auditAdminAction('set_default_banner'),
  setDefaultBanner
);

router.delete(
  '/default-banner',
  rateLimiter('adminAction'),
  auditAdminAction('clear_default_banner'),
  clearDefaultBanner
);

// Lightweight connectivity check for admin login
router.get(
  '/ping',
  rateLimiter('adminInsight'),
  auditAdminAction('admin_ping'),
  (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  }
);

// Debug endpoint for verification
router.get(
  '/debug-stats',
  rateLimiter('adminInsight'),
  auditAdminAction('get_debug_stats'),
  getDebugStats
);

export default router;

