import mongoose, { Schema } from 'mongoose';

/**
 * A reusable sponsor/event banner asset. One asset can be assigned to many rooms at once
 * (see RoomBannerAssignment) — it is not tied to a single room. The header strip and the chat
 * background are independent images, each with their own crop/position/zoom/fit.
 */
export const DEFAULT_BANNER_BACKGROUND_OPACITY = 0.3;

export type BannerFit = 'cover' | 'contain';

/** Focal point (percent, 0-100) + zoom + fit mode used to render the banner in a given context
 *  via CSS (object-position/background-position + a scale transform) — no server-side image work. */
export interface IBannerFraming {
  x: number;
  y: number;
  zoom: number;
  /** 'cover' crops to fill the box; 'contain' shows the whole image, may letterbox. */
  fit: BannerFit;
}

const DEFAULT_FRAMING: IBannerFraming = { x: 50, y: 50, zoom: 1, fit: 'cover' };

export interface ISponsorBanner {
  title?: string;
  headerImageUrl: string;
  headerStoragePath?: string;
  headerFraming: IBannerFraming;
  backgroundImageUrl: string;
  backgroundStoragePath?: string;
  backgroundFraming: IBannerFraming;
  /** Opacity (0-1) of the background image layer behind chat messages. Admin-adjustable. */
  backgroundOpacity: number;
  createdAt: Date;
  updatedAt: Date;
}

const FramingSchema = new Schema<IBannerFraming>(
  {
    x: { type: Number, default: 50, min: 0, max: 100 },
    y: { type: Number, default: 50, min: 0, max: 100 },
    zoom: { type: Number, default: 1, min: 1, max: 3 },
    fit: { type: String, enum: ['cover', 'contain'], default: 'cover' },
  },
  { _id: false }
);

const SponsorBannerSchema = new Schema<ISponsorBanner>(
  {
    title: { type: String, trim: true, maxlength: 150 },
    headerImageUrl: { type: String, required: true, trim: true },
    headerStoragePath: { type: String, trim: true },
    headerFraming: { type: FramingSchema, default: () => ({ ...DEFAULT_FRAMING }) },
    backgroundImageUrl: { type: String, required: true, trim: true },
    backgroundStoragePath: { type: String, trim: true },
    backgroundFraming: { type: FramingSchema, default: () => ({ ...DEFAULT_FRAMING }) },
    backgroundOpacity: { type: Number, default: DEFAULT_BANNER_BACKGROUND_OPACITY, min: 0, max: 1 },
  },
  {
    timestamps: true,
    collection: 'sponsorbanners',
  }
);

export const SponsorBannerModel = mongoose.model<ISponsorBanner>(
  'SponsorBanner',
  SponsorBannerSchema
);
