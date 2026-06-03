import mongoose, { Schema } from 'mongoose';

export interface IGlobalStats {
  key: string; // e.g., 'totalVisitsLifetime', 'totalRoomsLifetime'
  value: number;
  lastUpdated: Date;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const GlobalStatsSchema = new Schema<IGlobalStats>(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Number, required: true, default: 0 },
    lastUpdated: { type: Date, default: Date.now, index: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

export const GlobalStatsModel = mongoose.model<IGlobalStats>('GlobalStats', GlobalStatsSchema);
