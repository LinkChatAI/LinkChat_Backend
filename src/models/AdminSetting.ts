import mongoose, { Schema } from 'mongoose';

/**
 * Singleton document holding the platform's runtime-configurable rules — the
 * knobs that were previously compile-time constants or env vars and therefore
 * required a redeploy to change.
 *
 * Modelled on DefaultBannerSetting's singleton pattern (`_id: 'global'`) rather
 * than the GlobalStats key/value bag, because these values are a heterogeneous
 * typed record read as a unit, not independent numeric counters.
 *
 * READ COST: never query this model directly from a hot path. Go through
 * adminSettingsService.getSettings(), which serves from an in-process cache and
 * falls back to env-derived defaults if Mongo is unreachable — so a room join or
 * upload never gains a DB round trip from this feature.
 */
export interface IAdminSettings {
  _id: string;

  // Room lifecycle rules
  defaultRoomExpiryHours: number;
  autoVanishHours: number;
  maxParticipantsPerRoom: number; // 0 = unlimited
  /** Minutes an admin-less room stays alive after the host leaves/disconnects before auto-deletion, unless the host rejoins. */
  adminLeaveGraceMinutes: number;

  // Upload rules
  maxFileSizeMb: number;
  fileUploadsEnabled: boolean;

  // System controls (kill switches)
  roomCreationEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string;

  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AdminSettingsSchema = new Schema<IAdminSettings>(
  {
    _id: { type: String, default: 'global' },

    defaultRoomExpiryHours: { type: Number, required: true, min: 0.0167, max: 720 },
    autoVanishHours: { type: Number, required: true, min: 0.0167, max: 720 },
    maxParticipantsPerRoom: { type: Number, required: true, min: 0, max: 100000 },
    adminLeaveGraceMinutes: { type: Number, required: true, min: 1, max: 1440 },

    maxFileSizeMb: { type: Number, required: true, min: 1, max: 2048 },
    fileUploadsEnabled: { type: Boolean, required: true, default: true },

    roomCreationEnabled: { type: Boolean, required: true, default: true },
    maintenanceMode: { type: Boolean, required: true, default: false },
    maintenanceMessage: { type: String, default: '', maxlength: 300 },

    updatedBy: { type: String },
  },
  {
    timestamps: true,
    collection: 'adminsettings',
  }
);

export const AdminSettingsModel = mongoose.model<IAdminSettings>('AdminSetting', AdminSettingsSchema);
