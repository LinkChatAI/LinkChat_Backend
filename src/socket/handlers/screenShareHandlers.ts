import { getRoomByCode } from '../../services/roomService.js';
import { logger } from '../../utils/logger.js';
import {
  addScreenShareRequest,
  getScreenSharePresenter,
  getScreenSharePublicState,
  hasPendingScreenShareRequest,
  removeScreenShareRequest,
  setScreenSharePresenter,
  updateScreenShareSettings,
} from '../screenShareState.js';
import {
  assertScreenShareAllowedInRoom,
  broadcastScreenShareState,
  checkScreenShareSignalRateLimit,
  emitToRoomOwner,
  emitToUserInRoom,
  isRoomOwner,
  stopScreenSharePresentation,
  validateScreenShareSignal,
} from '../screenShareService.js';
import { HandlerContext } from './types.js';

export const registerScreenShareHandlers = (ctx: HandlerContext): void => {
  const { io, socket, user, ensureUserInRoom, emitErrorAlert } = ctx;

  const guardRoom = async (): Promise<boolean> => {
    if (!ensureUserInRoom()) return false;
    const guard = await assertScreenShareAllowedInRoom(user.roomCode);
    if (!guard.ok) {
      socket.emit('error_alert', { message: guard.message });
      return false;
    }
    return true;
  };

  socket.on('screen_share:get_state', async () => {
    if (!ensureUserInRoom()) return;
    try {
      socket.emit('screen_share:state', getScreenSharePublicState(user.roomCode));
    } catch (error) {
      emitErrorAlert(error, 'Failed to load screen share state');
    }
  });

  socket.on(
    'screen_share:settings',
    async (data: { enabled?: boolean; moderatorsOnly?: boolean }) => {
      if (!(await guardRoom())) return;
      try {
        if (!(await isRoomOwner(user.roomCode, user.userId))) {
          socket.emit('error_alert', { message: 'Only the room host can change screen share settings' });
          return;
        }

        const partial: { enabled?: boolean; moderatorsOnly?: boolean } = {};
        if (typeof data?.enabled === 'boolean') partial.enabled = data.enabled;
        if (typeof data?.moderatorsOnly === 'boolean') partial.moderatorsOnly = data.moderatorsOnly;

        if (Object.keys(partial).length === 0) {
          socket.emit('error_alert', { message: 'No valid settings provided' });
          return;
        }

        updateScreenShareSettings(user.roomCode, partial);

        if (partial.enabled === false) {
          stopScreenSharePresentation(
            io,
            user.roomCode,
            user.userId,
            'Screen sharing was disabled by the host'
          );
        } else {
          broadcastScreenShareState(io, user.roomCode);
        }
      } catch (error) {
        emitErrorAlert(error, 'Failed to update screen share settings');
      }
    }
  );

  socket.on('screen_share:request', async () => {
    if (!(await guardRoom())) return;
    try {
      // A pending request is broadcast to the whole room in screen_share:state
      // (userId + nickname) so the host can approve it — for Ghost Mode that
      // would be an outright identity leak to every participant, not just the
      // host. Read-only monitoring never needs to present, so block outright.
      if (user.isGhost) {
        socket.emit('error_alert', { message: 'Ghost Mode is read-only — screen sharing is disabled.' });
        return;
      }

      if (await isRoomOwner(user.roomCode, user.userId)) {
        socket.emit('error_alert', {
          message: 'As the room host, use Share screen to start directly',
        });
        return;
      }

      const result = addScreenShareRequest(user.roomCode, user.userId, user.nickname);
      if (!result.ok) {
        socket.emit('error_alert', { message: result.reason });
        if (result.code === 'queued') {
          broadcastScreenShareState(io, user.roomCode);
        }
        return;
      }

      const room = await getRoomByCode(user.roomCode);
      if (room?.ownerId) {
        await emitToRoomOwner(io, user.roomCode, room.ownerId, 'screen_share:request_pending', {
          userId: user.userId,
          nickname: user.nickname,
        });
      }

      socket.emit('screen_share:request_sent', { message: 'Request sent to the room host' });
      broadcastScreenShareState(io, user.roomCode);
    } catch (error) {
      emitErrorAlert(error, 'Failed to request screen sharing');
    }
  });

  socket.on(
    'screen_share:respond',
    async (data: { requestUserId?: string; approved?: boolean }) => {
      if (!(await guardRoom())) return;
      try {
        if (!(await isRoomOwner(user.roomCode, user.userId))) {
          socket.emit('error_alert', { message: 'Only the room host can approve screen sharing' });
          return;
        }

        const requestUserId = data?.requestUserId?.trim();
        if (!requestUserId) {
          socket.emit('error_alert', { message: 'Invalid request' });
          return;
        }
        if (typeof data?.approved !== 'boolean') {
          socket.emit('error_alert', { message: 'Invalid approval response' });
          return;
        }

        if (!hasPendingScreenShareRequest(user.roomCode, requestUserId) && data.approved) {
          socket.emit('error_alert', { message: 'No pending request from this participant' });
          broadcastScreenShareState(io, user.roomCode);
          return;
        }

        removeScreenShareRequest(user.roomCode, requestUserId);

        if (data.approved) {
          if (getScreenSharePresenter(user.roomCode)) {
            socket.emit('error_alert', { message: 'Another participant is already presenting' });
            broadcastScreenShareState(io, user.roomCode);
            return;
          }

          const delivered = await emitToUserInRoom(
            io,
            user.roomCode,
            requestUserId,
            'screen_share:approved',
            {}
          );
          if (!delivered) {
            socket.emit('error_alert', {
              message: 'That participant is no longer in the room',
            });
            broadcastScreenShareState(io, user.roomCode);
            return;
          }

          const sockets = await io.in(user.roomCode).fetchSockets();
          const target = sockets.find(
            (s) => (s.data as { user?: { userId?: string } })?.user?.userId === requestUserId
          );
          const nickname =
            (target?.data as { user?: { nickname?: string } })?.user?.nickname || 'Presenter';

          setScreenSharePresenter(user.roomCode, requestUserId, nickname);
          io.to(user.roomCode).emit('screen_share:started', {
            presenterId: requestUserId,
            presenterNickname: nickname,
          });
        } else {
          await emitToUserInRoom(io, user.roomCode, requestUserId, 'screen_share:denied', {});
        }

        broadcastScreenShareState(io, user.roomCode);
      } catch (error) {
        emitErrorAlert(error, 'Failed to respond to screen share request');
      }
    }
  );

  socket.on('screen_share:start_as_host', async () => {
    if (!(await guardRoom())) return;
    try {
      if (!(await isRoomOwner(user.roomCode, user.userId))) {
        socket.emit('error_alert', { message: 'Only the room host can start presenting directly' });
        return;
      }

      const state = getScreenSharePublicState(user.roomCode);
      if (!state.settings.enabled) {
        socket.emit('error_alert', { message: 'Screen sharing is disabled in this room' });
        return;
      }
      if (state.presenterId && state.presenterId !== user.userId) {
        socket.emit('error_alert', { message: 'Another participant is already presenting' });
        return;
      }

      setScreenSharePresenter(user.roomCode, user.userId, user.nickname);
      socket.emit('screen_share:approved', {});
      io.to(user.roomCode).emit('screen_share:started', {
        presenterId: user.userId,
        presenterNickname: user.nickname,
      });
      broadcastScreenShareState(io, user.roomCode);
    } catch (error) {
      emitErrorAlert(error, 'Failed to start screen sharing');
    }
  });

  socket.on('screen_share:stop', async () => {
    if (!ensureUserInRoom()) return;
    try {
      const presenterId = getScreenSharePresenter(user.roomCode);
      if (!presenterId) return;

      const owner = await isRoomOwner(user.roomCode, user.userId);
      if (user.userId !== presenterId && !owner) {
        socket.emit('error_alert', { message: 'Only the presenter or room host can stop sharing' });
        return;
      }

      stopScreenSharePresentation(io, user.roomCode, user.userId);
    } catch (error) {
      emitErrorAlert(error, 'Failed to stop screen sharing');
    }
  });

  socket.on(
    'screen_share:signal',
    async (data: {
      targetUserId?: string;
      signalType?: string;
      payload?: unknown;
    }) => {
      if (!ensureUserInRoom()) return;

      // WebRTC signals carry `fromUserId` straight to the target socket —
      // Ghost Mode never presents or views, so it never has a legitimate
      // reason to be in this exchange. Block outright rather than rely on it
      // never reaching a valid presenter/viewer pairing below.
      if (user.isGhost) return;

      const targetUserId = data?.targetUserId?.trim();
      const signalType = data?.signalType;
      if (!targetUserId || !signalType) return;

      if (!checkScreenShareSignalRateLimit(user.userId, user.roomCode)) {
        logger.warn('Screen share signal rate limit exceeded', {
          userId: user.userId,
          roomCode: user.roomCode,
        });
        return;
      }

      if (!validateScreenShareSignal(signalType, data.payload)) {
        logger.warn('Invalid screen share signal rejected', {
          signalType,
          userId: user.userId,
          roomCode: user.roomCode,
        });
        return;
      }

      const presenterId = getScreenSharePresenter(user.roomCode);
      if (!presenterId) return;

      const fromUserId = user.userId;
      const isPresenter = fromUserId === presenterId;
      const isTargetPresenter = targetUserId === presenterId;
      if (!isPresenter && !isTargetPresenter) return;
      if (fromUserId === targetUserId) return;

      const delivered = await emitToUserInRoom(io, user.roomCode, targetUserId, 'screen_share:signal', {
        fromUserId,
        signalType,
        payload: data.payload,
      });

      if (!delivered) {
        logger.debug('Screen share signal target not in room', {
          targetUserId,
          roomCode: user.roomCode,
        });
      }
    }
  );

  socket.on('screen_share:viewer_ready', async () => {
    if (!ensureUserInRoom()) return;
    // Announcing readiness tells the presenter this socket's userId/nickname
    // directly (so they can address a WebRTC offer to it) — the presenter
    // would see "Ghost Admin" join as a viewer. Silently viewing a live
    // screen share isn't achievable without that handshake, so Ghost Mode
    // simply never becomes a viewer.
    if (user.isGhost) return;
    try {
      const presenterId = getScreenSharePresenter(user.roomCode);
      if (!presenterId || presenterId === user.userId) return;

      await emitToUserInRoom(io, user.roomCode, presenterId, 'screen_share:viewer_joined', {
        viewerId: user.userId,
        viewerNickname: user.nickname,
      });
    } catch (error) {
      logger.warn('screen_share:viewer_ready failed', {
        error: error instanceof Error ? error.message : String(error),
        roomCode: user.roomCode,
        userId: user.userId,
      });
    }
  });

  // Emitted by the presenter after getDisplayMedia() resolves (screen-picker accepted).
  // Because screen_share:started fires BEFORE the presenter finishes capturing, viewers
  // may have already sent viewer_ready and been ignored (isPresentingRef was still false).
  // This event re-fires viewer_joined for every current room member so the presenter
  // can create WebRTC offers for all of them.
  socket.on('screen_share:presenting_started', async () => {
    if (!ensureUserInRoom()) return;
    try {
      const presenterId = getScreenSharePresenter(user.roomCode);
      if (!presenterId || presenterId !== user.userId) return;

      const sockets = await io.in(user.roomCode).fetchSockets();
      for (const s of sockets) {
        const sUser = (s.data as { user?: { userId?: string; isGhost?: boolean } })?.user;
        // Defense in depth: a ghost socket should never reach this loop (it
        // never calls viewer_ready), but never surface one to the presenter
        // even if that changes.
        if (sUser?.userId && sUser.userId !== user.userId && !sUser.isGhost) {
          socket.emit('screen_share:viewer_joined', { viewerId: sUser.userId });
        }
      }

      logger.debug('screen_share:presenting_started — notified presenter of existing viewers', {
        roomCode: user.roomCode,
        presenterId: user.userId,
        viewerCount: sockets.length - 1,
      });
    } catch (error) {
      logger.warn('screen_share:presenting_started failed', {
        error: error instanceof Error ? error.message : String(error),
        roomCode: user.roomCode,
        userId: user.userId,
      });
    }
  });
};

export { getScreenSharePublicState } from '../screenShareState.js';
export { clearScreenShareState } from '../screenShareState.js';
