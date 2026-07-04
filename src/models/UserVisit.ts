import mongoose, { Schema } from 'mongoose';

export interface IUserVisit {
  userId: string; // User's persistent UUID
  roomCode: string;
  nickname?: string;
  joinedAt: Date;
  leftAt?: Date;
  sessionDuration?: number; // milliseconds
  messagesSent?: number; // Number of messages sent during this visit
  /** Public IP the visit was joined from — used only to resolve approximate location below. */
  ipAddress?: string;
  /** Approximate, city-level location resolved from ipAddress. Never derived from browser GPS. */
  city?: string;
  region?: string;
  country?: string;
  lat?: number;
  lon?: number;
  createdAt: Date;
  updatedAt: Date;
}

const UserVisitSchema = new Schema<IUserVisit>(
  {
    userId: { type: String, required: true, index: true },
    roomCode: { type: String, required: true, index: true },
    nickname: { type: String },
    joinedAt: { type: Date, required: true, default: Date.now, index: true },
    leftAt: { type: Date },
    sessionDuration: { type: Number }, // milliseconds
    messagesSent: { type: Number, default: 0 },
    ipAddress: { type: String },
    city: { type: String },
    region: { type: String },
    country: { type: String, index: true },
    lat: { type: Number },
    lon: { type: Number },
  },
  { timestamps: true }
);

// Compound indexes for common queries
UserVisitSchema.index({ userId: 1, joinedAt: -1 });
UserVisitSchema.index({ roomCode: 1, joinedAt: -1 });
UserVisitSchema.index({ joinedAt: -1 });
UserVisitSchema.index({ country: 1, region: 1, city: 1 });

export const UserVisitModel = mongoose.model<IUserVisit>('UserVisit', UserVisitSchema);
