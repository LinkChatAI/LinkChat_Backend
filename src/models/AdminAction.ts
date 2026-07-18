import mongoose, { Schema } from 'mongoose';

export interface AdminAction {
  adminId: string; // Admin identifier (from secret hash, or a real User._id for per-user RBAC actions)
  adminEmail?: string; // Populated for per-user RBAC actions (requireAdminRole), absent for shared-secret actions
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
    // adminId/action/endpoint/success deliberately have NO standalone
    // `index: true` here — each is already the leading field of a compound
    // index below ({field:1, createdAt:-1}), and Mongo can serve a
    // single-field query/sort from a compound index's prefix, so a separate
    // single-field index would only add write overhead on every audited
    // request with no query it uniquely serves. ipAddress keeps its
    // standalone index since no compound index covers it.
    adminId: { type: String, required: true },
    adminEmail: { type: String },
    action: { type: String, required: true },
    endpoint: { type: String, required: true },
    method: { type: String, required: true },
    ipAddress: { type: String, required: true, index: true },
    userAgent: { type: String },
    requestId: { type: String, required: true, unique: true, index: true },
    success: { type: Boolean, required: true, default: true },
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

// NOTE: the 4 dropped standalone indexes (adminId/action/endpoint/success)
// existed in previously-deployed collections. Mongoose does not drop
// indexes removed from the schema automatically — run
// `AdminActionModel.syncIndexes()` once in each deployed environment
// (or `db.adminactions.dropIndex(...)` manually) to actually reclaim the
// write overhead they were costing.

export const AdminActionModel = mongoose.model<AdminAction>('AdminAction', AdminActionSchema);

