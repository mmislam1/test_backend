import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IFolder extends Document {
  name: string;
  userId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const FolderSchema = new Schema<IFolder>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
  },
);

FolderSchema.index({ userId: 1, name: 1 }, { unique: true });

export const Folder = mongoose.model<IFolder>('Folder', FolderSchema);
