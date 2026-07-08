import mongoose, { Schema, Types } from 'mongoose';

/**
 * Maps a room to the sponsor banner asset it currently displays. A room has at most one
 * assignment; a single banner asset (SponsorBanner) can be referenced by many assignments.
 */
export interface IRoomBannerAssignment {
  roomCode: string;
  bannerId: Types.ObjectId;
  /** Mirrors the room's expiresAt so an orphaned assignment self-cleans if the room is ever
   *  removed by MongoDB's TTL sweep directly (which runs with no application code). */
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RoomBannerAssignmentSchema = new Schema<IRoomBannerAssignment>(
  {
    roomCode: { type: String, required: true, unique: true, trim: true },
    bannerId: { type: Schema.Types.ObjectId, required: true, ref: 'SponsorBanner', index: true },
    expiresAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'roombannerassignments',
  }
);

RoomBannerAssignmentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RoomBannerAssignmentModel = mongoose.model<IRoomBannerAssignment>(
  'RoomBannerAssignment',
  RoomBannerAssignmentSchema
);
