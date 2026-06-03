import mongoose, { Schema } from 'mongoose';

export interface IUserVisit {
  userId: string; // User's persistent UUID
  roomCode: string;
  nickname?: string;
  joinedAt: Date;
  leftAt?: Date;
  sessionDuration?: number; // milliseconds
  messagesSent?: number; // Number of messages sent during this visit
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
  },
  { timestamps: true }
);

// Compound indexes for common queries
UserVisitSchema.index({ userId: 1, joinedAt: -1 });
UserVisitSchema.index({ roomCode: 1, joinedAt: -1 });
UserVisitSchema.index({ joinedAt: -1 });

export const UserVisitModel = mongoose.model<IUserVisit>('UserVisit', UserVisitSchema);
