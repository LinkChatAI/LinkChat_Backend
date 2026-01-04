import mongoose, { Schema } from 'mongoose';

export interface AdminAction {
  adminId: string; // Admin identifier (from secret hash or session)
  action: string;
  endpoint: string;
  method: string;
  ipAddress: string;
  userAgent?: string;
  requestId: string; // Unique request ID for tracing
  success: boolean;
  errorMessage?: string;
  responseTime?: number; // Response time in ms
  metadata?: Record<string, any>;
  createdAt: Date;
}

const AdminActionSchema = new Schema<AdminAction>(
  {
    adminId: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    endpoint: { type: String, required: true, index: true },
    method: { type: String, required: true },
    ipAddress: { type: String, required: true, index: true },
    userAgent: { type: String },
    requestId: { type: String, required: true, unique: true, index: true },
    success: { type: Boolean, required: true, default: true, index: true },
    errorMessage: { type: String },
    responseTime: { type: Number },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Indexes for audit queries
AdminActionSchema.index({ createdAt: -1 });
AdminActionSchema.index({ adminId: 1, createdAt: -1 });
AdminActionSchema.index({ endpoint: 1, createdAt: -1 });
AdminActionSchema.index({ success: 1, createdAt: -1 }); // Failed actions (query with success: false)
AdminActionSchema.index({ action: 1, createdAt: -1 });

export const AdminActionModel = mongoose.model<AdminAction>('AdminAction', AdminActionSchema);

