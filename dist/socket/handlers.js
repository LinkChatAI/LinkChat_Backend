import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { registerJoinHandlers } from './handlers/joinHandlers.js';
import { registerMessageHandlers } from './handlers/messageHandlers.js';
import { registerReactionHandlers } from './handlers/reactionHandlers.js';
import { registerRoomLifecycleHandlers } from './handlers/roomLifecycleHandlers.js';
import { registerScreenShareHandlers } from './handlers/screenShareHandlers.js';
import { registerModerationHandlers } from './handlers/moderationHandlers.js';
import { registerRoomAdminHandlers } from './handlers/roomAdminHandlers.js';
import { recordReconnect } from '../services/platformMetricsService.js';
import { trackSocketConnected, trackSocketDisconnected } from '../services/metricsService.js';
import { clearPendingUserLeaveTimer } from './handlers/roomLifecycleHandlers.js';
import { resolveGhostModeFromSocket } from '../utils/ghostMode.js';
// Re-export for backward compatibility (adminRoomService imports this)
export { clearPendingDeletionTimer } from './handlers/roomLifecycleHandlers.js';
export const handleSocketConnection = (io, socket) => {
    const recovered = socket.recovered === true;
    if (recovered) {
        recordReconnect();
    }
    trackSocketConnected();
    socket.on('disconnect', () => trackSocketDisconnected());
    // On a successful connectionStateRecovery, Socket.IO already restores
    // socket.data (including the `user` object we stash there in joinHandlers)
    // before the 'connection' event fires. Reuse it instead of building a blank
    // user with roomCode: '' — otherwise ensureUserInRoom() (which gates
    // sendMessage/typing/edits/reactions) would wrongly fail right after a
    // "successful" silent recovery, since the client intentionally skips
    // re-emitting joinRoom in that case.
    const recoveredUser = recovered ? socket.data?.user : undefined;
    const authUserId = socket.handshake.auth?.userId;
    const user = recoveredUser ?? {
        userId: (authUserId && typeof authUserId === 'string' && authUserId.trim()) ? authUserId.trim() : uuidv4(),
        nickname: socket.handshake.auth?.nickname || 'Anonymous',
        roomCode: '',
    };
    socket.data = { user };
    // Resolve Ghost Mode from the httpOnly session cookie in the background.
    // Deliberately not awaited here — registration of the event handlers below
    // must stay in the same tick as 'connection', otherwise a client that
    // emits joinRoom immediately on connect could have it dropped before a
    // listener exists. A recovered connection already carries `isGhost` on the
    // restored user object, so there's nothing to re-resolve.
    const ghostReady = recoveredUser
        ? Promise.resolve()
        : resolveGhostModeFromSocket(socket).then((isGhost) => {
            user.isGhost = isGhost;
        });
    // Recovery means this connection never went through joinRoom again — clear
    // any grace-period removal timer started by the disconnect that preceded
    // this recovery, since the user is provably still here.
    if (recovered && user.roomCode) {
        clearPendingUserLeaveTimer(user.roomCode, user.userId);
    }
    const typingUsers = new Map();
    const ensureUserInRoom = () => {
        if (!user.roomCode || user.roomCode.trim() === '')
            return false;
        const room = io.sockets.adapter.rooms.get(user.roomCode);
        return room ? room.has(socket.id) : false;
    };
    const emitErrorAlert = (error, defaultMessage) => {
        const errorMessage = error instanceof Error ? error.message : defaultMessage;
        logger.error(defaultMessage, {
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
            userId: user.userId,
            roomCode: user.roomCode,
        });
        socket.emit('error_alert', { message: errorMessage });
        socket.emit('error', { message: errorMessage });
    };
    const ctx = {
        io,
        socket,
        user,
        typingUsers,
        ensureUserInRoom,
        emitErrorAlert,
        ghostReady,
    };
    registerJoinHandlers(ctx);
    registerMessageHandlers(ctx);
    registerReactionHandlers(ctx);
    registerRoomLifecycleHandlers(ctx);
    registerScreenShareHandlers(ctx);
    registerModerationHandlers(ctx);
    registerRoomAdminHandlers(ctx);
};
//# sourceMappingURL=handlers.js.map