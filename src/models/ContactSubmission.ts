import mongoose, { Schema } from 'mongoose';

export interface IContactSubmission {
  name: string;
  email: string;
  message: string;
  category?: 'general' | 'support' | 'feedback' | 'bug' | 'feature' | 'sales' | 'other';
  phone?: string;
  plan?: string;
  ipAddress?: string;
  userAgent?: string;
  isSpam?: boolean;
  spamReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ContactSubmissionSchema = new Schema<IContactSubmission>(
  {
    name: { 
      type: String, 
      required: true, 
      trim: true,
      maxlength: 200 
    },
    email: { 
      type: String, 
      required: true, 
      trim: true,
      lowercase: true,
      maxlength: 255,
      index: true 
    },
    message: { 
      type: String, 
      required: true, 
      trim: true,
      maxlength: 5000 
    },
    category: {
      type: String,
      enum: ['general', 'support', 'feedback', 'bug', 'feature', 'sales', 'other'],
      default: 'general',
      index: true
    },
    phone: {
      type: String,
      trim: true,
      maxlength: 30,
    },
    plan: {
      type: String,
      trim: true,
      maxlength: 50,
    },
    ipAddress: {
      type: String,
      index: true
    },
    userAgent: {
      type: String
    },
    isSpam: {
      type: Boolean,
      default: false,
      index: true
    },
    spamReason: {
      type: String
    },
  },
  { 
    timestamps: true,
    collection: 'contactsubmissions'
  }
);

// Index for admin queries (recent submissions, by category, etc.)
ContactSubmissionSchema.index({ createdAt: -1 });
ContactSubmissionSchema.index({ category: 1, createdAt: -1 });
ContactSubmissionSchema.index({ isSpam: 1, createdAt: -1 });
ContactSubmissionSchema.index({ email: 1, createdAt: -1 });

export const ContactSubmissionModel = mongoose.model<IContactSubmission>(
  'ContactSubmission',
  ContactSubmissionSchema
);

