import mongoose, { Schema } from 'mongoose';
const RoomSchema = new Schema({
    code: { type: String, required: true, unique: true, index: true },
    token: { type: String, required: true },
    ownerId: { type: String, index: true }, // Anonymous guest UUID of the room creator (for RBAC)
    ownerUserId: { type: String, index: true, sparse: true }, // Authenticated user ID (premium sync)
    name: { type: String, index: true },
    slug: { type: String, unique: true, sparse: true, index: true },
    isPublic: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    participants: { type: [String], default: [] },
    isEnded: { type: Boolean, default: false },
    endedAt: { type: Date },
    endedBy: { type: String },
    isLocked: { type: Boolean, default: false, index: true }, // Room is locked (admin left, 24h countdown)
    lockedAt: { type: Date, index: true }, // When the room was locked
    coHostIds: { type: [String], default: [] }, // Partial admin powers (mute, kick, etc.)
    slowModeMessagesPerMinute: { type: Number, default: 0 }, // 0 = off
    participantsCanSend: { type: Boolean, default: true }, // false = host/co-hosts only
    joinLocked: { type: Boolean, default: false }, // true = no new participants can join
    storageUsed: { type: Number, default: 0 }, // Total storage used in bytes
    plan: {
        type: String,
        enum: ['free', 'premium', 'pro', 'enterprise'],
        default: 'free',
    }, // Controls feature access (video uploads, storage limits, etc.)
}, { timestamps: true });
// NOTE: there is deliberately NO TTL index on expiresAt.
//
// A TTL index deletes the Room document from inside mongod, running zero
// application code. Everything else a room owns — GCS/local file objects,
// Redis keys, per-instance in-memory state, connected sockets — is cleaned up
// by application code keyed off finding the expired Room. Mongo's TTL monitor
// sweeps every 60s, so it always won the race against the cleanup sweep and
// deleted the room out from under it; the sweep then found nothing to do and
// every other resource was orphaned.
//
// Expiry is now driven by cleanupService.cleanupExpiredRooms, which finds
// expired rooms and runs the full purgeRoom teardown. A plain (non-TTL) index
// on expiresAt keeps that query fast.
//
// If you re-add expireAfterSeconds here, room file/Redis/memory cleanup
// silently stops. Existing deployments must drop the legacy index — see
// scripts/drop-room-ttl-index.mjs.
RoomSchema.index({ expiresAt: 1 });
// Compound index for public room queries
RoomSchema.index({ slug: 1, isPublic: 1 });
// Index for expiration checks
RoomSchema.index({ expiresAt: 1, isPublic: 1 });
// Compound index for auto-vanish queries (locked rooms ready to vanish)
RoomSchema.index({ isLocked: 1, lockedAt: 1, isEnded: 1 });
// Index for auto-vanish worker queries (optimized for frequent checks)
RoomSchema.index({ isLocked: 1, lockedAt: 1, isEnded: 1, expiresAt: 1 });
export const RoomModel = mongoose.model('Room', RoomSchema);
//# sourceMappingURL=Room.js.map