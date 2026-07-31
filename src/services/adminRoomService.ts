import { Server } from 'socket.io';
import { RoomModel } from '../models/Room.js';
import { AdminActionModel } from '../models/AdminAction.js';
import { logger } from '../utils/logger.js';
import { getIoInstance } from '../socket/ioInstance.js';
import { emitAdminInsightUpdate } from '../socket/adminHandlers.js';
import { purgeRoom } from './roomPurgeService.js';
import { clearPendingDeletionTimer } from '../socket/handlers/roomTimers.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Admin-controlled room vanish
 * Immediately destroys a room (active or locked) with proper cleanup and user notification
 */
export const adminVanishRoom = async (
  roomCode: string,
  adminId: string,
  previousStatus: 'active' | 'locked'
): Promise<void> => {
  const io = getIoInstance();
  if (!io) {
    throw new Error('Socket.IO instance not available');
  }

  // 1. Verify room exists and get current state
  const room = await RoomModel.findOne({ code: roomCode });
  if (!room) {
    throw new Error(`Room ${roomCode} not found`);
  }

  // 1.5. Clear any pending deletion timer (explicit vanish bypasses grace period)
  clearPendingDeletionTimer(roomCode);

  // 2-8. Full teardown. This path previously cleared no in-memory state at all
  // — screen-share, moderation (mute/kick), slow-mode, receipts, room cache and
  // the metrics gauge all survived an admin vanish, and the kick list in
  // particular then blocked those users from the next room to reuse the code.
  const purgeResult = await purgeRoom(roomCode, {
    reason: 'This room has been vanished by an administrator.',
    trigger: 'admin',
    event: 'room_vanished',
    actorId: 'admin',
    systemMessage: 'This room has been vanished by an administrator.',
  });

  const messageDeleteResult = { deletedCount: purgeResult.messagesDeleted };

  if (!purgeResult.roomDeleted) {
    logger.warn(`Room ${roomCode} was already deleted`);
  }

  // 9. Log admin action to audit log
  try {
    await AdminActionModel.create({
      adminId,
      action: 'room_vanished',
      endpoint: `/admin/rooms/${roomCode}/vanish`,
      method: 'POST',
      ipAddress: 'system', // Will be set by middleware
      requestId: uuidv4(),
      success: true,
      metadata: {
        roomCode,
        previousStatus,
        roomName: room.name || roomCode,
        participantsCount: room.participants?.length || 0,
        messagesDeleted: messageDeleteResult.deletedCount,
      },
    });
  } catch (auditError: any) {
    logger.error('Failed to log admin action', {
      error: auditError instanceof Error ? auditError.message : String(auditError),
    });
    // Don't throw - audit logging failure shouldn't fail the operation
  }

  // 10. Emit admin insight update
  try {
    await emitAdminInsightUpdate(io, 'room_admin_vanished', {
      roomCode,
      previousStatus,
      adminId,
    });
  } catch (insightError: any) {
    logger.warn('Failed to emit admin insight update', {
      error: insightError instanceof Error ? insightError.message : String(insightError),
    });
  }
};

