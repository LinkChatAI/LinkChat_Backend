import { Response } from 'express';
import { AdminRequest } from '../middleware/adminAuth.js';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { UserVisitModel } from '../models/UserVisit.js';
import { lockRoom, unlockRoom, endRoom } from '../services/roomService.js';
import { getLiveUserCountsForRooms } from '../services/roomPresenceService.js';
import { getIoInstance } from '../socket/ioInstance.js';
import { invalidateDashboardCache } from '../middleware/adminCache.js';
import { emitAdminInsightUpdate } from '../socket/adminHandlers.js';
import { logger } from '../utils/logger.js';

/**
 * Room inspector + moderation actions.
 *
 * All mutations reuse the existing roomService functions rather than writing to
 * RoomModel directly, so admin-initiated lock/unlock/end goes through the same
 * code path (and the same invariants) as the host-initiated versions.
 *
 * Live clients are notified with `room_locked` / `room_unlocked` / `roomEnded`.
 * Note that ChatRoom.tsx already had handlers registered for `room_locked` and
 * `room_unlocked` but nothing in the backend had ever emitted them — those
 * handlers were dead code until now.
 */

const messageCountForRoom = async (code: string): Promise<number> => {
  try {
    // Served by the {roomCode:1, createdAt:-1} compound index prefix.
    return await MessageModel.countDocuments({ roomCode: code });
  } catch {
    return 0;
  }
};

/** GET /admin/rooms/:code/inspect — everything known about one room. */
export const inspectRoom = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) {
      res.status(400).json({ error: 'Room code is required' });
      return;
    }

    const room = await RoomModel.findOne({ code }).lean().exec();
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const [liveCounts, messageCount, fileStats, recentVisits] = await Promise.all([
      getLiveUserCountsForRooms(getIoInstance(), [code]),
      messageCountForRoom(code),
      MessageModel.aggregate([
        { $match: { roomCode: code, type: { $in: ['file', 'image', 'video'] } } },
        {
          $group: {
            _id: null,
            fileCount: { $sum: 1 },
            totalBytes: { $sum: { $ifNull: ['$fileMeta.size', 0] } },
          },
        },
      ]).allowDiskUse(true),
      // {roomCode:1, joinedAt:-1} index — indexed sort, no scan.
      UserVisitModel.find({ roomCode: code })
        .sort({ joinedAt: -1 })
        .limit(25)
        .select('userId nickname joinedAt leftAt sessionDuration messagesSent country city')
        .lean()
        .exec(),
    ]);

    const files = fileStats[0] || { fileCount: 0, totalBytes: 0 };
    const now = Date.now();

    res.json({
      room: {
        code: room.code,
        name: room.name || room.code,
        slug: room.slug || null,
        plan: room.plan || 'free',
        isPublic: !!room.isPublic,
        isLocked: !!room.isLocked,
        isEnded: !!room.isEnded,
        lockedAt: room.lockedAt || null,
        endedAt: room.endedAt || null,
        endedBy: room.endedBy || null,
        ownerId: room.ownerId || null,
        ownerUserId: room.ownerUserId ? String(room.ownerUserId) : null,
        coHostIds: room.coHostIds || [],
        createdAt: room.createdAt,
        expiresAt: room.expiresAt,
        expiresInMinutes: room.expiresAt
          ? Math.round((new Date(room.expiresAt).getTime() - now) / 60000)
          : null,
        slowModeMessagesPerMinute: room.slowModeMessagesPerMinute || 0,
        participantsCanSend: room.participantsCanSend !== false,
        joinLocked: !!room.joinLocked,
        storageUsedBytes: room.storageUsed || 0,
      },
      live: {
        userCount: liveCounts.get(code) ?? 0,
      },
      content: {
        messageCount,
        fileCount: files.fileCount,
        fileBytes: files.totalBytes,
      },
      recentVisits: recentVisits.map((v) => ({
        userId: v.userId,
        nickname: v.nickname || null,
        joinedAt: v.joinedAt,
        leftAt: v.leftAt || null,
        sessionMinutes: v.sessionDuration ? Math.round((v.sessionDuration / 60000) * 10) / 10 : null,
        messagesSent: v.messagesSent || 0,
        location: [v.city, v.country].filter(Boolean).join(', ') || null,
      })),
    });
  } catch (error: unknown) {
    logger.error('Error inspecting room', {
      error: error instanceof Error ? error.message : String(error),
      roomCode: req.params.code,
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to inspect room' });
  }
};

type ModerationAction = 'lock' | 'unlock' | 'end' | 'extend';

const applyAction = async (
  action: ModerationAction,
  code: string,
  adminId: string,
  extendHours: number
): Promise<string> => {
  const io = getIoInstance();

  switch (action) {
    case 'lock': {
      const room = await lockRoom(code);
      io?.to(code).emit('room_locked', { lockedAt: room.lockedAt || new Date() });
      return `Room ${code} locked (read-only)`;
    }
    case 'unlock': {
      await unlockRoom(code);
      io?.to(code).emit('room_unlocked', {});
      return `Room ${code} unlocked`;
    }
    case 'end': {
      await endRoom(code, adminId);
      io?.to(code).emit('roomEnded', { endedBy: adminId });
      return `Room ${code} ended`;
    }
    case 'extend': {
      const room = await RoomModel.findOne({ code }).exec();
      if (!room) throw new Error('Room not found');
      const base = Math.max(Date.now(), new Date(room.expiresAt).getTime());
      room.expiresAt = new Date(base + extendHours * 60 * 60 * 1000);
      await room.save();
      return `Room ${code} extended by ${extendHours}h`;
    }
  }
};

/** POST /admin/rooms/:code/moderate — lock | unlock | end | extend. */
export const moderateRoom = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const code = String(req.params.code || '').trim();
    const action = String(req.body?.action || '') as ModerationAction;
    const extendHours = Number(req.body?.hours ?? 1);

    if (!code) {
      res.status(400).json({ error: 'Room code is required' });
      return;
    }
    if (!['lock', 'unlock', 'end', 'extend'].includes(action)) {
      res.status(400).json({ error: 'Invalid action. Use lock, unlock, end or extend.' });
      return;
    }
    if (action === 'extend' && (!Number.isFinite(extendHours) || extendHours <= 0 || extendHours > 720)) {
      res.status(400).json({ error: 'hours must be between 0 and 720' });
      return;
    }

    const exists = await RoomModel.exists({ code });
    if (!exists) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const message = await applyAction(action, code, req.adminId || 'admin', extendHours);

    await invalidateDashboardCache();
    const io = getIoInstance();
    if (io) {
      emitAdminInsightUpdate(io, `room_${action}`, { roomCode: code }).catch((err) =>
        logger.warn('Failed to emit admin insight update after moderation', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }

    logger.info('Admin moderation action', { action, roomCode: code, adminId: req.adminId });
    res.json({ success: true, message, action, roomCode: code });
  } catch (error: unknown) {
    logger.error('Error moderating room', {
      error: error instanceof Error ? error.message : String(error),
      roomCode: req.params.code,
      adminId: req.adminId,
    });
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to moderate room',
    });
  }
};

/**
 * GET /admin/rooms/search?q=&status=&limit=
 * Room lookup across code / name / slug for the moderation tab. Regex is
 * anchored (^) so it can use the code/name/slug indexes rather than scanning.
 */
export const searchRooms = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || 'all');
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '25'), 10)));

    const filter: Record<string, unknown> = {};
    if (q) {
      const anchored = new RegExp('^' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ code: anchored }, { name: anchored }, { slug: anchored }];
    }
    if (status === 'active') {
      filter.isLocked = false;
      filter.isEnded = false;
    } else if (status === 'locked') {
      filter.isLocked = true;
    } else if (status === 'ended') {
      filter.isEnded = true;
    }

    const rooms = await RoomModel.find(filter)
      .select('code name slug isLocked isEnded plan createdAt expiresAt storageUsed')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    const codes = rooms.map((r) => r.code);
    const liveCounts = await getLiveUserCountsForRooms(getIoInstance(), codes);

    res.json({
      rooms: rooms.map((r) => ({
        code: r.code,
        name: r.name || r.code,
        slug: r.slug || null,
        plan: r.plan || 'free',
        isLocked: !!r.isLocked,
        isEnded: !!r.isEnded,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        storageUsedBytes: r.storageUsed || 0,
        userCount: liveCounts.get(r.code) ?? 0,
      })),
    });
  } catch (error: unknown) {
    logger.error('Error searching rooms', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to search rooms' });
  }
};
