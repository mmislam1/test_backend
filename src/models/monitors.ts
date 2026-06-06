import mongoose, { Schema, Document, Types } from 'mongoose';

// --- Monitor Model ---
export interface IMonitor extends Document {
  userId: Types.ObjectId;
  searchId: Types.ObjectId;
  status: 'active' | 'inactive';
  lastScan: Date;
}

const MonitorSchema = new Schema<IMonitor>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  searchId: { type: Schema.Types.ObjectId, ref: 'Search', required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  lastScan: { type: Date, default: Date.now }
}, { timestamps: true });

export const Monitor = mongoose.models.Monitor || mongoose.model<IMonitor>('Monitor', MonitorSchema);

