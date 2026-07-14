import mongoose, { Schema, Types } from 'mongoose';

/**
 * Singleton pointer to the platform-wide default sponsor banner — shown in any room that has
 * no room-specific RoomBannerAssignment. Deliberately NOT a set of per-room assignment rows:
 * unlike a room banner, the default has no room to key off of and must apply uniformly to every
 * room (existing and future) without a write-time fan-out. resolveRoomBanner() falls back to
 * this only when a room has no explicit assignment, so a room's own banner always wins.
 */
export interface IDefaultBannerSetting {
  _id: string;
  bannerId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DefaultBannerSettingSchema = new Schema<IDefaultBannerSetting>(
  {
    _id: { type: String, default: 'global' },
    bannerId: { type: Schema.Types.ObjectId, required: true, ref: 'SponsorBanner' },
  },
  {
    timestamps: true,
    collection: 'defaultbannersettings',
  }
);

export const DefaultBannerSettingModel = mongoose.model<IDefaultBannerSetting>(
  'DefaultBannerSetting',
  DefaultBannerSettingSchema
);
