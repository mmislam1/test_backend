import mongoose, { Schema, Document, Types } from 'mongoose';


export interface IAlert extends Document {
  userId: Types.ObjectId;
  title: string;
  message?: string;
  type: 'new_match' | 'scan_update' | 'billing' | 'system';
  isRead: boolean;
  actionUrl?: string;
  metadata?: Record<string, any>;
  timestamp: Date;
}

const AlertSchema = new Schema<IAlert>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  message: { type: String },
  type: {
    type: String,
    enum: ['new_match', 'scan_update', 'billing', 'system'],
    default: 'system',
  },
  isRead: { type: Boolean, default: false },
  actionUrl: { type: String },
  metadata: { type: Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now }
});

export const Alert = mongoose.models.Alert || mongoose.model<IAlert>('Alert', AlertSchema);