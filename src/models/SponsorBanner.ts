import mongoose, { Schema } from 'mongoose';

/** One sponsor/event banner per room, shown in that room's header and chat background. */
export interface ISponsorBanner {
  roomCode: string;
  title?: string;
  imageUrl: string;
  storagePath?: string;
  /** Mirrors the assigned room's expiresAt so an orphaned banner self-cleans if the room
   *  is ever removed by MongoDB's TTL sweep directly (which runs with no application code). */
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SponsorBannerSchema = new Schema<ISponsorBanner>(
  {
    roomCode: { type: String, required: true, unique: true, trim: true },
    title: { type: String, trim: true, maxlength: 150 },
    imageUrl: { type: String, required: true, trim: true },
    storagePath: { type: String, trim: true },
    expiresAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'sponsorbanners',
  }
);

SponsorBannerSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SponsorBannerModel = mongoose.model<ISponsorBanner>(
  'SponsorBanner',
  SponsorBannerSchema
);
